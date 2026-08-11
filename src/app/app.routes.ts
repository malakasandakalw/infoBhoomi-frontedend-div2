import { Routes } from '@angular/router';

import { LoginPageComponent } from './components/auth/login-page/login-page.component';
import { MainComponent } from './components/main/main.component';
import { LandingHomePageComponent } from './landing/home-page/home-page.component';

import { authGuard } from './components/auth/guards/auth.guard';
import { adminGuard } from './components/auth/guards/admin.guard';
import { permissionCheck } from './components/auth/guards/permission-check.guard';
import { superAdminGuard } from './components/auth/guards/super-admin.guard';

export const routes: Routes = [
  { path: '', component: LandingHomePageComponent },
  { path: 'login', component: LoginPageComponent },
  { path: 'main', component: MainComponent, canActivate: [authGuard] },

  // ── Admin routes (lazy-loaded) ───────────────────────────────────────────
  {
    path: 'admin-home',
    loadComponent: () =>
      import('./admin/home-page/home-page.component').then((m) => m.HomePageComponent),
    canActivate: [adminGuard],
  },
  {
    path: 'admin-organizations',
    loadComponent: () =>
      import('./admin/organizations/organizations-list/organizations-list.component').then(
        (m) => m.OrganizationsListComponent,
      ),
    canActivate: [superAdminGuard],
  },
  {
    path: 'admin-organizations-create',
    loadComponent: () =>
      import('./admin/organizations/organizations-create/organizations-create.component').then(
        (m) => m.OrganizationsCreateComponent,
      ),
    canActivate: [superAdminGuard],
  },
  {
    path: 'admin-organizations-edit/:org_id',
    loadComponent: () =>
      import('./admin/organizations/organization-edit/organization-edit.component').then(
        (m) => m.OrganizationEditComponent,
      ),
    canActivate: [superAdminGuard],
  },
  {
    path: 'admin-organizations-location-edit/:org_id',
    loadComponent: () =>
      import(
        './admin/organizations/organizations-location-edit/organizations-location-edit.component'
      ).then((m) => m.OrganizationsLocationEditComponent),
    canActivate: [superAdminGuard],
  },
  {
    path: 'admin-organizations-area-edit/:org_id',
    loadComponent: () =>
      import('./admin/organizations/organization-area-edit/organization-area-edit.component').then(
        (m) => m.OrganizationAreaEditComponent,
      ),
    canActivate: [superAdminGuard],
  },
  {
    path: 'admin-layers-list',
    loadComponent: () =>
      import('./admin/layers-list/layers-list.component').then((m) => m.LayersListComponent),
    canActivate: [adminGuard, permissionCheck],
    data: { permission: { id: 253 as const, action: 'view' as const } },
  },
  {
    path: 'admin-users-list',
    loadComponent: () =>
      import('./admin/user/users-list/users-list.component').then((m) => m.UsersListComponent),
    canActivate: [adminGuard, permissionCheck],
    data: { permission: { id: 251 as const, action: 'view' as const } },
  },
  {
    path: 'admin-user-create',
    loadComponent: () =>
      import('./admin/user/users-create/users-create.component').then(
        (m) => m.UsersCreateComponent,
      ),
    canActivate: [adminGuard, permissionCheck],
    data: { permission: { id: 251 as const, action: 'add' as const } },
  },
  {
    path: 'admin-user-edit',
    loadComponent: () =>
      import('./admin/user/user-edit/user-edit.component').then((m) => m.UserEditComponent),
    canActivate: [adminGuard],
    data: { permission: { id: 251 as const, action: 'edit' as const } },
  },
  {
    path: 'admin-roles-list',
    loadComponent: () =>
      import('./admin/roles-list/roles-list.component').then((m) => m.RolesListComponent),
    canActivate: [adminGuard, permissionCheck],
    data: { permission: { id: 252 as const, action: 'view' as const } },
  },
];
