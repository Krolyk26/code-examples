
import amqp.proxy.converter.XmlMessageConverter;
import cache.market.MarketMappingCache;
import model.jpa.JpaBoostedMarkets;
import model.mongo.FeedMessage;
import repository.feed.BoostedMarketsJpaRepository;
import repository.feed.TenantJpaRepository;
import repository.feed.reactive.FeedMessageReactiveRepository;
import utils.odds.BoostStrategyFactory;
import utils.odds.MarketUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

@Slf4j
@Component
public class DefaultOddsChangeMessagePublisher implements OddsChangeMessagePublisher {

    private static final String DEFAULT_NODE_ID = "-";

    private final MessagePublisher messagePublisher;
    private final TenantJpaRepository tenantJpaRepository;
    private final BoostedMarketsJpaRepository boostedMarketsJpaRepository;
    private final BoostStrategyFactory boostStrategyFactory;
    private final MarketMappingCache marketMappingCache;
    private final FeedMessageReactiveRepository feedMessageReactiveRepository;
    private final XmlMessageConverter messageConverter;
    private final boolean feedLogEnabled;

    private volatile Map<String, Long> tenantsToProfile = Collections.emptyMap();

    public DefaultOddsChangeMessagePublisher(
            @Qualifier("defaultMessagePublisher") MessagePublisher messagePublisher,
            TenantJpaRepository tenantJpaRepository,
            BoostedMarketsJpaRepository boostedMarketsJpaRepository,
            BoostStrategyFactory boostStrategyFactory,
            MarketMappingCache marketMappingCache,
            FeedMessageReactiveRepository feedMessageReactiveRepository,
            XmlMessageConverter messageConverter,
            @Value("${feed.log.enabled:false}") boolean feedLogEnabled
    ) {
        this.messagePublisher = messagePublisher;
        this.tenantJpaRepository = tenantJpaRepository;
        this.boostedMarketsJpaRepository = boostedMarketsJpaRepository;
        this.boostStrategyFactory = boostStrategyFactory;
        this.marketMappingCache = marketMappingCache;
        this.feedMessageReactiveRepository = feedMessageReactiveRepository;
        this.messageConverter = messageConverter;
        this.feedLogEnabled = feedLogEnabled;
    }

    @Override
    public void publish(OddsChange message, String sportUrn, RouteParameters routeParameters, Map<String, Object> headers) {
        long sportId = URN.parse(sportUrn).getId();

        if (routeParameters.getTenantId() != null) {
            publishToSingleTenant(message, sportUrn, sportId, routeParameters, headers);
        } else if (routeParameters.getProfileId() != null) {
            publishToProfile(message, sportUrn, sportId, routeParameters, headers);
        } else {
            broadcastToAll(message, sportUrn, sportId, routeParameters, headers);
        }
    }

    private void publishToSingleTenant(OddsChange message, String sportUrn, long sportId,
                                       RouteParameters routeParameters, Map<String, Object> headers) {
        String tenantId = routeParameters.getTenantId();
        Long profileId = tenantsToProfile.get(tenantId);

        if (profileId == null) {
            log.warn("Tenant {} not found in active cache. Skipping publication.", tenantId);
            return;
        }

        OddsChange messageToPublish = resolveBoostedMessage(message, sportUrn, profileId);
        messagePublisher.publish(messageToPublish, sportId, routeParameters.getNodeId(), tenantId, headers);
    }

    private void publishToProfile(OddsChange message, String sportUrn, long sportId,
                                  RouteParameters routeParameters, Map<String, Object> headers) {
        Long profileId = routeParameters.getProfileId();
        OddsChange messageToPublish = resolveBoostedMessage(message, sportUrn, profileId);

        Set<String> tenants = getTenantsByProfileId(profileId);
        tenants.forEach(tenantId ->
                messagePublisher.publish(messageToPublish, sportId, DEFAULT_NODE_ID, tenantId, headers)
        );

        logFeedMessageIfEnabled(profileId, messageToPublish);
    }

    private void broadcastToAll(OddsChange message, String sportUrn, long sportId,
                                RouteParameters routeParameters, Map<String, Object> headers) {
        if (!isBoostApplicable(message, sportUrn)) {
            publishRawMessageToAll(message, sportId, headers);
            return;
        }

        String fixtureUrn = message.getEventId().toString();
        List<JpaBoostedMarkets> allBoosts = boostedMarketsJpaRepository.findAllByFixtures(List.of(fixtureUrn));

        if (allBoosts.isEmpty()) {
            publishRawMessageToAll(message, sportId, headers);
            return;
        }

        Map<Long, Map<String, JpaBoostedMarkets>> profileBoostsMap = groupBoostsByProfile(allBoosts);
        Map<Long, Set<String>> tenantsByProfile = getTenantsGroupedByProfile();

        tenantsByProfile.forEach((profileId, tenants) -> {
            Map<String, JpaBoostedMarkets> specificBoosts = profileBoostsMap.get(profileId);
            OddsChange messageToPublish = (specificBoosts == null)
                    ? message
                    : applyBoost(message, specificBoosts);

            tenants.forEach(tenantId ->
                    messagePublisher.publish(messageToPublish, sportId, DEFAULT_NODE_ID, tenantId, headers)
            );

            logFeedMessageIfEnabled(profileId, messageToPublish);
        });
    }

    private void publishRawMessageToAll(OddsChange message, long sportId, Map<String, Object> headers) {
        tenantsToProfile.keySet().forEach(tenantId ->
                messagePublisher.publish(message, sportId, DEFAULT_NODE_ID, tenantId, headers)
        );
        logFeedMessageIfEnabled(null, message);
    }

    private OddsChange resolveBoostedMessage(OddsChange message, String sportUrn, Long profileId) {
        if (!isBoostApplicable(message, sportUrn)) {
            return message;
        }

        String fixtureUrn = message.getEventId().toString();
        List<JpaBoostedMarkets> boosts = boostedMarketsJpaRepository.findAllByProfileIdAndFixtureUrn(profileId, fixtureUrn);

        if (boosts.isEmpty()) {
            return message;
        }

        Map<String, JpaBoostedMarkets> boostMap = boosts.stream()
                .collect(Collectors.toMap(this::getMarketKey, Function.identity()));

        return applyBoost(message, boostMap);
    }

    private boolean isBoostApplicable(OddsChange message, String sportUrn) {
        if (message.getProduct() != ProductType.PREMATCH) {
            return false;
        }
        return message.getMarkets().stream()
                .anyMatch(market -> marketMappingCache.isPrimaryMarket(market.getId(), sportUrn));
    }

    private OddsChange applyBoost(OddsChange message, Map<String, JpaBoostedMarkets> boostedMarketsMap) {
        OddsChange messageClone = message.clone();
        List<OddsChangeMarket> newMarkets = messageClone.getMarkets().stream()
                .map(market -> {
                    String key = getMarketKey(market);
                    JpaBoostedMarkets boostedConfig = boostedMarketsMap.get(key);
                    return (boostedConfig != null) ? applyStrategy(market, boostedConfig) : market;
                })
                .collect(Collectors.toList());

        messageClone.getOdds().setMarkets(newMarkets);
        return messageClone;
    }

    private OddsChangeMarket applyStrategy(OddsChangeMarket market, JpaBoostedMarkets boostedConfig) {
        var builtMarket = MarketUtil.build(market);
        var strategy = boostStrategyFactory.getStrategy(boostedConfig.getStrategy());
        strategy.calculate(builtMarket, boostedConfig.getPercent());
        return MarketUtil.toOddsChangeMarket(market, builtMarket);
    }

    private void logFeedMessageIfEnabled(Long profileId, OddsChange message) {
        if (!feedLogEnabled) return;

        try {
            String payload = messageConverter.writeValueAsString(message);
            var feedMessage = FeedMessage.builder()
                    .eventId(message.getEventId().toString())
                    .timestamp(message.getTimestamp())
                    .payload(payload)
                    .profileId(profileId)
                    .build();

            feedMessageReactiveRepository.save(feedMessage)
                    .doOnError(e -> log.error("Error saving feed log", e))
                    .subscribe();
        } catch (IOException e) {
            log.error("Error serializing message for logging", e);
        }
    }

    @Scheduled(fixedDelay = 10, timeUnit = TimeUnit.MINUTES)
    public void updateTenantsProfilesMapping() {
        try {
            List<Tenant> tenants = tenantJpaRepository.findAll();
            this.tenantsToProfile = tenants.stream()
                    .filter(t -> t.getTenantProfile() != null)
                    .collect(Collectors.toMap(
                            tenant -> tenant.getId().toString(),
                            tenant -> tenant.getTenantProfile().getId(),
                            (existing, replacement) -> existing
                    ));
        } catch (Exception e) {
            log.error("Failed to refresh tenant profiles mapping", e);
        }
    }

    private Set<String> getTenantsByProfileId(Long profileId) {
        return tenantsToProfile.entrySet().stream()
                .filter(entry -> Objects.equals(entry.getValue(), profileId))
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());
    }

    private Map<Long, Set<String>> getTenantsGroupedByProfile() {
        return tenantsToProfile.entrySet().stream()
                .collect(Collectors.groupingBy(
                        Map.Entry::getValue,
                        Collectors.mapping(Map.Entry::getKey, Collectors.toSet())
                ));
    }

    private Map<Long, Map<String, JpaBoostedMarkets>> groupBoostsByProfile(List<JpaBoostedMarkets> boosts) {
        return boosts.stream()
                .collect(Collectors.groupingBy(
                        b -> b.getProfile().getId(),
                        Collectors.toMap(this::getMarketKey, Function.identity(), (a, b) -> a)
                ));
    }

    private String getMarketKey(OddsChangeMarket market) {
        return market.getId() + "|" + market.getSpecifiers();
    }

    private String getMarketKey(JpaBoostedMarkets market) {
        return market.getMarketId() + "|" + market.getMarketSpecifier();
    }
}
