
import lombok.Builder;
import lombok.Getter;

import java.util.Collections;
import java.util.Map;

public interface OddsChangeMessagePublisher {

    String BROADCAST_NODE_ID = "-";

    void publish(OddsChange message, String sportUrn, RouteParameters routeParameters, Map<String, Object> headers);

    default void publish(OddsChange message, String sportUrn, RouteParameters routeParameters) {
        publish(message, sportUrn, routeParameters, Collections.emptyMap());
    }

    @Getter
    @Builder
    class RouteParameters {
        private final String tenantId;
        private final Long profileId;
        private final String nodeId;

        public static RouteParameters broadcast() {
            return RouteParameters.builder()
                    .nodeId(BROADCAST_NODE_ID)
                    .build();
        }

        public static RouteParameters profile(Long profileId) {
            return RouteParameters.builder()
                    .profileId(profileId)
                    .nodeId(BROADCAST_NODE_ID)
                    .build();
        }

        public static RouteParameters tenant(String tenantId, String nodeId) {
            return RouteParameters.builder()
                    .tenantId(tenantId)
                    .nodeId(nodeId)
                    .build();
        }
    }
}
