import { HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { select, Store } from '@ngrx/store';
import { of } from 'rxjs';
import {
  catchError,
  concatMap,
  exhaustMap,
  filter,
  map,
  mergeMap,
  switchMap,
  tap,
  withLatestFrom,
} from 'rxjs/operators';

import { AuthRequest } from '@app/core/model/definitions/auth-request.interface';
import { AuthError } from '@app/core/model/definitions/auth-error.interface';
import { BootstrapConfig } from '@app/core/model/bootstrap-config.model';
import { User } from '@core/model/user.model';
import { Company } from '@app/core/model/company.model';
import { AuthenticationSuccessAction } from '@core/store/models/auth.action.interface';

import { AuthService } from '../../service/auth.service';
import { UserService } from '@app/features/user-account/services/user.service';
import { LoaderModalService } from '@shared/components/loader-modal/service/loader-modal.service';
import { EnvService } from '@envs/env-service';
import { SessionStorageKey, SessionStorageService } from '@app/core/service/session-storage.service';
import {
  SnackbarEventType,
  SNACKBAR_LENGTH_LONG,
  SNACKBAR_LENGTH_SHORT,
  SnackbarService,
} from '@shared/utils/snackbar.service';
import { AuthUtils } from '@shared/utils/auth.utils';

import { AuthActionTypes, AuthActions, BootstrapActions } from '@core/store';
import { AuthSelectors } from '@core/store/selectors/auth.selector';
import { BootstrapSelectors } from '../selectors/bootstrap.selector';

@Injectable()
export class AuthEffects {
  private readonly LOGIN_PATH = '/login';
  private readonly DASHBOARD_PATH = '/dashboard';
  private readonly VERIFICATION_NEEDED_PATH = '/account-verification-needed';
  private readonly FORGOT_PASSWORD_SUCCESS_PATH = '/auth/forgot-password-success';

  constructor(
    private actions$: Actions,
    private authService: AuthService,
    private userService: UserService,
    private router: Router,
    private loader: LoaderModalService,
    private snackbarService: SnackbarService,
    private envService: EnvService,
    private store: Store,
    private sessionStorageService: SessionStorageService
  ) {}

  goToLogin$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActionTypes.GO_TO_LOGIN),
        tap(() => this.router.navigateByUrl(this.LOGIN_PATH))
      ),
    { dispatch: false }
  );

  login$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.LOGIN),
      map((action: { authenticatedUser: AuthRequest }) => action.authenticatedUser),
      switchMap((authParams: AuthRequest) =>
        this.authService.login(authParams).pipe(
          mergeMap((user: User) => {
            // Aggregating user settings and permissions after successful login
            user.mapUserPrivileges();
            user.mapGroupPrivileges();
            user.company.mapApplicationSettings();
            return [AuthActions.loginSuccess({ user })];
          }),
          tap(() => this.loader.hide()),
          catchError((response: { error: AuthError }) =>
            of(AuthActions.loginFail({ error: response.error }))
          )
        )
      )
    )
  );

  authSuccess$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActionTypes.LOGIN_SUCCESS),
        withLatestFrom(this.store.select(BootstrapSelectors.selectBootstrapConfig)),
        filter(([, bsConfig]) => !!bsConfig),
        tap(([action, bsConfig]: [AuthenticationSuccessAction, BootstrapConfig]) => {
          this.handleTenantRedirection(bsConfig?.host, action.user.company, true);
        })
      ),
    { dispatch: false }
  );

  authFailure$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActionTypes.LOGIN_FAIL),
        withLatestFrom(this.store.pipe(select(AuthSelectors.selectUsername))),
        tap(([response, username]: [{ error: AuthError }, string]) => {
          let errorMsg: string;

          if (response.error.companyDisabled || response.error.accountDisabled) {
            errorMsg = 'Account has been disabled. Please contact your administrator.';
          } else if (response.error.emailVerificationNeeded) {
            this.router.navigate([this.VERIFICATION_NEEDED_PATH], { queryParams: { email: username } });
            return;
          } else if (response.error.blackListed) {
            errorMsg = response.error.errorMessage;
          } else if (response.error.redirectUrl) {
            this.router.navigateByUrl(response.error.redirectUrl);
            errorMsg = 'Your password is expired. Please change your password.';
          } else {
            errorMsg = 'Invalid username or password. Please double-check your credentials.';
          }
          
          this.snackbarService.showPrioritisedSnackbar(errorMsg, SNACKBAR_LENGTH_LONG, SnackbarEventType.ERROR);
        })
      ),
    { dispatch: false }
  );

  myAccount$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.MY_ACCOUNT),
      concatMap(() =>
        this.authService.getAccount().pipe(
          switchMap((user: User) => {
            user.mapUserPrivileges();
            user.mapGroupPrivileges();
            user.company.mapApplicationSettings();
            return [
              AuthActions.myAccountSuccess({ user }),
              BootstrapActions.loadUserPreferences()
            ];
          }),
          catchError(() => {
            this.snackbarService.showSnackbar(
              'Error retrieving account details',
              SNACKBAR_LENGTH_LONG,
              SnackbarEventType.ERROR
            );
            return of(AuthActions.myAccountFail());
          })
        )
      )
    )
  );

  myAccountSuccess$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActionTypes.MY_ACCOUNT_SUCCESS),
        withLatestFrom(this.store.select(BootstrapSelectors.selectBootstrapConfig)),
        filter(([, bsConfig]) => !!bsConfig),
        tap(([action, bsConfig]: [AuthenticationSuccessAction, BootstrapConfig]) => {
          const company = AuthUtils.isChildCompanyContext() 
            ? action.user.company.parentCompany 
            : action.user.company;
            
          this.sessionStorageService.remove(SessionStorageKey.REDIRECT_URL);
          this.handleTenantRedirection(bsConfig?.host, company, false);
        })
      ),
    { dispatch: false }
  );

  myAccountFail$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActionTypes.MY_ACCOUNT_FAIL),
        tap(() => {
          const redirectUrl = this.getRedirectPathName();
          this.sessionStorageService.set(SessionStorageKey.REDIRECT_URL, redirectUrl);
        })
      ),
    { dispatch: false }
  );

  forgotPassword$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.FORGOT_PASSWORD),
      map((action: { username: string; captchaToken: string }) => action),
      exhaustMap((payload) =>
        this.authService.forgotPassword(payload.username, payload.captchaToken).pipe(
          map(() => AuthActions.forgotPasswordSuccess({ forgotSuccess: true })),
          catchError((error) => {
            this.snackbarService.showSnackbar(
              'Error during password reset request',
              SNACKBAR_LENGTH_LONG,
              SnackbarEventType.ERROR
            );
            return of(AuthActions.forgotPasswordFail({ error }));
          })
        )
      )
    )
  );

  forgotPasswordSuccess$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActionTypes.FORGOT_PASSWORD_SUCCESS),
        tap(() => this.router.navigate([this.FORGOT_PASSWORD_SUCCESS_PATH]))
      ),
    { dispatch: false }
  );

  resetPassword$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.RESET_PASSWORD),
      map((action: { password: string; token: string }) => action),
      exhaustMap((payload) =>
        this.authService.resetPassword({ password: payload.password, token: payload.token }).pipe(
          map(() => AuthActions.resetPasswordSuccess()),
          catchError((error: HttpErrorResponse) => {
            if (error.status === 404) {
              this.snackbarService.showSnackbar(
                'Token invalid. It is outdated or already used',
                SNACKBAR_LENGTH_LONG,
                SnackbarEventType.ERROR
              );
            }
            return of(AuthActions.resetPasswordFail({ error }));
          })
        )
      )
    )
  );

  resetPasswordSuccess$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.RESET_PASSWORD_SUCCESS),
      map(() => {
        this.snackbarService.showSnackbar(
          'Password successfully updated',
          SNACKBAR_LENGTH_SHORT,
          SnackbarEventType.SUCCESS
        );
        return AuthActions.goToLogin();
      })
    )
  );

  logout$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.LOGOUT),
      switchMap(() =>
        this.authService.logout().pipe(map(() => AuthActions.logOutSuccess()))
      )
    )
  );

  logoutSuccess$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.LOGOUT_SUCCESS),
      map(() => AuthActions.goToLogin())
    )
  );

  getChildCompanies$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActionTypes.GET_CHILD_COMPANIES),
      switchMap(() =>
        this.userService.getChildCompanies().pipe(
          map((childCompanies) => AuthActions.getChildCompaniesSuccess({ childCompanies })),
          catchError((error) => {
            this.snackbarService.showSnackbar(
              'Error loading child accounts',
              SNACKBAR_LENGTH_LONG,
              SnackbarEventType.ERROR
            );
            return of(AuthActions.getChildCompaniesFail({ error }));
          })
        )
      )
    )
  );

  // --- Helpers ---

  /**
   * Handles multi-tenant routing based on subdomain presence.
   */
  private handleTenantRedirection(host: string, company: Company, isLogin: boolean): void {
    if (company) {
      const hostname = `${company.subdomain}.${host}`;
      const savedRedirectUrl = this.sessionStorageService.get(SessionStorageKey.REDIRECT_URL);
      const currentPath = this.getRedirectPathName();
      const targetPath = savedRedirectUrl || currentPath || this.DASHBOARD_PATH;

      if (window.location.hostname !== hostname) {
        this.router.navigate([], { queryParamsHandling: 'preserve', replaceUrl: true, skipLocationChange: true });
        
        const newOrigin = `${window.location.protocol}//${hostname}:${window.location.port}`;
        window.location.replace(`${newOrigin}${targetPath}`);
        
        this.envService.baseUrl = `${newOrigin}`;
        this.sessionStorageService.remove(SessionStorageKey.REDIRECT_URL);
        return;
      }
    }

    if (isLogin) {
      const savedRedirectUrl = this.sessionStorageService.get(SessionStorageKey.REDIRECT_URL);
      const targetPath = savedRedirectUrl || this.DASHBOARD_PATH;

      this.router.navigateByUrl(targetPath);
      this.sessionStorageService.remove(SessionStorageKey.REDIRECT_URL);
    }
  }

  private getRedirectPathName(): string {
    const redirectPath = window.location.pathname + window.location.search;
    if (redirectPath.includes('login')) {
        return this.DASHBOARD_PATH;
    }
    return redirectPath || this.DASHBOARD_PATH;
  }
}
