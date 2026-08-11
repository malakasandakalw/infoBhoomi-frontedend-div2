import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpEvent, HttpHeaders } from '@angular/common/http';
import { Inject, inject, Injectable, PLATFORM_ID } from '@angular/core';
import { catchError, Observable, shareReplay, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AreaRow } from './org-area-define.service';
import { UserService } from './user.service';

@Injectable({
  providedIn: 'root',
})
export class APIsService {
  private userService = inject(UserService);
  token: any;
  user_id: any;
  org_id: any;

  private readonly _permCache = new Map<string, Observable<any>>();
  private _layersPermCache: Observable<any> | null = null;

  clearPermissionsCache(): void {
    this._permCache.clear();
    this._layersPermCache = null;
  }

  constructor(
    private http: HttpClient,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {}

  private readonly baseUrl = environment.API_URL;

  loadFromStorage() {
    if (isPlatformBrowser(this.platformId)) {
      const user = this.userService.getUser();
      this.token = localStorage.getItem('Token');
      this.user_id = user?.user_id || null;
      this.org_id = user?.org_id || null;
    } else {
      this.token = null;
      this.user_id = null;
      this.org_id = null;
    }
  }

  /** Returns an HttpHeaders object with Authorization and optional Content-Type. */
  private h(json = true): HttpHeaders {
    const hdrs: Record<string, string> = { Authorization: `Token ${this.token}` };
    if (json) hdrs['Content-Type'] = 'application/json';
    return new HttpHeaders(hdrs);
  }

  /** Filters a data object to only allowed keys, removing null/undefined/empty values. */
  private filterKeys(data: Record<string, any>, keys: string[]): Record<string, any> {
    return Object.fromEntries(
      Object.entries(data).filter(
        ([k, v]) => keys.includes(k) && v !== '' && v !== null && v !== undefined,
      ),
    );
  }

  // =============================================================================
  // PERMISSIONS
  // =============================================================================

  public readonly GET_PERMISSIONS = `${this.baseUrl}role-permission/`;

  /** Base permission method — post a list of permission IDs to the role-permission endpoint.
   * Results are cached per unique ID set for the lifetime of the session. */
  getPermissions(ids: number[]): Observable<any> {
    const key = ids.join(',');
    if (!this._permCache.has(key)) {
      this._permCache.set(
        key,
        this.http.post(this.GET_PERMISSIONS, { permission_id: ids }, { headers: this.h() }).pipe(
          // Don't let a transient failure stay cached: evict the key so the
          // next caller retries instead of replaying a cached error/empty.
          catchError((err) => {
            this._permCache.delete(key);
            return throwError(() => err);
          }),
          shareReplay(1),
        ),
      );
    }
    return this._permCache.get(key)!;
  }

  getSummaryPermission() {
    return this.getPermissions([10, 11, 24]);
  }
  getBuildingSummaryPermission() {
    return this.getPermissions([111, 113, 131, 108]);
  }
  getBuildingTabAdminPermisions() {
    return this.getPermissions([
      101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114,
    ]);
  }
  getResidentialPermisions() {
    return this.getPermissions([145, 146, 147, 148, 149]);
  }
  getLandTenurePermisions() {
    return this.getPermissions([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 15]);
  }
  getBuldingTenurePermisions() {
    return this.getPermissions([212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 174]);
  }
  getLandTabAdminPermisions() {
    return this.getPermissions([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }
  getTaxandAssessmentPermisions() {
    return this.getPermissions([24, 25, 26, 27, 28, 29, 30, 31, 32]);
  }
  getTaxInformationPermisions() {
    return this.getPermissions([33, 34, 35, 36, 37]);
  }
  getBuildingTaxandAssessPermisions() {
    return this.getPermissions([131, 132, 133, 134, 135, 136, 137, 138, 139]);
  }
  getBuildingTaxInfoPermisions() {
    return this.getPermissions([140, 141, 142, 143, 144]);
  }
  getLandTabUtilityPermisions() {
    return this.getPermissions([19, 20, 21, 22, 23, 24]);
  }
  getBuildingTabUtilityPermisions() {
    return this.getPermissions([122, 123, 124, 125, 126, 127, 128, 129, 130]);
  }
  getLandOverViewPermisions() {
    return this.getPermissions([12, 13, 14, 15, 16, 17, 18]);
  }
  getBuildingOverViewPermisions() {
    return this.getPermissions([115, 116, 117, 118, 119, 120, 121]);
  }
  getDefaultLayersPermisions() {
    return this.getPermissions([80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92]);
  }
  getToolbarPermission() {
    return this.getPermissions([201]);
  }
  getAdminPermissions() {
    return this.getPermissions([251, 252, 253]);
  }
  getLayersPopPermissions() {
    return this.getPermissions([94]);
  }
  getRRRPermisions() {
    return this.getPermissions([38]);
  }

  /** Layer panel permissions — uses a separate endpoint. Cached for the session. */
  getLayersPermisions() {
    if (!this._layersPermCache) {
      this._layersPermCache = this.http
        .get(`${this.baseUrl}role-permission-layerpanel/`, { headers: this.h() })
        .pipe(shareReplay(1));
    }
    return this._layersPermCache;
  }

  /** All permissions for a role — uses a separate endpoint. */
  getPermisionsList(role_id: any) {
    return this.http.get(`${this.baseUrl}role-permission-all/role_id=${role_id}/`, {
      headers: this.h(),
    });
  }

  // =============================================================================
  // IMPORT / EXPORT — URL CONSTANTS
  // =============================================================================

  public readonly IMPORT_RASTER_DATA = `${this.baseUrl}import_raster_data/`;
  public readonly IMPORT_TEMP_VECTOR_DATA = `${this.baseUrl}import_vector_data/`;
  public readonly LOAD_TEMP_VECTOR_DATA = (user_id: string) =>
    `${this.baseUrl}import_vector_data/user=${user_id}/`;
  public readonly REMOVE_TEMP_VECTOR_DATA = (record_id: string) =>
    `${this.baseUrl}import_vector_data/update/id=${record_id}/`;

  importRasterData(formData: FormData): Observable<HttpEvent<any>> {
    return this.http.post(this.IMPORT_RASTER_DATA, formData, {
      headers: this.h(false),
      reportProgress: true,
      observe: 'events',
    });
  }

  // =============================================================================
  // SURVEY REP / TOOLS — URL CONSTANTS
  // =============================================================================

  public readonly POST_SURVEY_REP_DATA = `${this.baseUrl}survey_rep_data/`;
  public readonly UPDATE_SURVEY_REP_DATA = (uuid: string) =>
    `${this.baseUrl}survey_rep_data/update/id=${uuid}/`;
  public readonly DELETE_SURVEY_BATCH_DATA = `${this.baseUrl}survey_rep_data/bulk_delete/`;

  updateSurveyRepData(id: string | number, data: Record<string, any>): Observable<any> {
    return this.http.patch(`${this.baseUrl}survey_rep_data/update/id=${id}/`, data, {
      headers: this.h(),
    });
  }

  queryParcels(
    layerId: number,
    conditions: { field: string; operator: string; value: string }[],
    logic: 'AND' | 'OR',
  ) {
    this.loadFromStorage();
    return this.http.post<{ count: number; layer_id: number; features: any[] }>(
      `${this.baseUrl}query-parcels/`,
      { layer_id: layerId, conditions, logic },
      { headers: this.h() },
    );
  }

  exportQueryShp(
    layerId: number,
    conditions: { field: string; operator: string; value: string }[],
    logic: 'AND' | 'OR',
  ) {
    this.loadFromStorage();
    return this.http.post(
      `${this.baseUrl}query-parcels/export-shp/`,
      { layer_id: layerId, conditions, logic },
      { headers: this.h(), responseType: 'blob' },
    );
  }

  // =============================================================================
  // LAND TAB — URL CONSTANTS
  // =============================================================================

  public readonly GET_LAND_INFO = (su_id: string) => `${this.baseUrl}admin-info/su_id=${su_id}/`;
  public readonly GET_LAND_OVERVIEW = (su_id: string) =>
    `${this.baseUrl}land-overview-info/su_id=${su_id}/`;
  public readonly GET_LAND_UTIL_INFO = (su_id: string) =>
    `${this.baseUrl}utinet-info/su_id=${su_id}/`;
  public readonly GET_ASSES_TAX_INFO = (su_id: string) =>
    `${this.baseUrl}tax-assess-info/su_id=${su_id}/`;
  public readonly GET_LAND_TENURE = (su_id: string) =>
    `${this.baseUrl}ownership-rights-info/su_id=${su_id}/`;
  public readonly UPDATE_LT_ADMIN_INFO = (su_id: string) =>
    `${this.baseUrl}admin-info/update/su_id=${su_id}/`;
  public readonly UPDATE_LT_LAND_OVERVIEW = (su_id: string) =>
    `${this.baseUrl}land-overview-info/update/su_id=${su_id}/`;
  public readonly UPDATE_LT_UTIL_INFO = (su_id: string) =>
    `${this.baseUrl}utinet-info/update/su_id=${su_id}/`;
  public readonly UPDATE_TAX_ASSES_INFO = (su_id: string) =>
    `${this.baseUrl}tax-assess-info/update/su_id=${su_id}/`;
  public readonly SIDE_PANEL_IMG = (su_id: string) =>
    `${this.baseUrl}attrib-image-retrive/su_id=${su_id}/`;
  public readonly ADMIN_UNIT_TYPES_DD = (ddListID: string) => `${this.baseUrl}${ddListID}/`;

  // =============================================================================
  // LAND TAB — GET
  // =============================================================================

  getAdministrativeTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-baunittype-10/`, { headers: this.h() });
  }

  getAdministrativeInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}lnd-admin-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getSummaryDetails(su_id_value: any) {
    return this.http.get(`${this.baseUrl}lnd-summary/su_id=${su_id_value}/`, { headers: this.h() });
  }

  getLandOverViewInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}land-overview-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getItInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}lnd-utinet-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getLandMetadata(su_id: any) {
    return this.http.get(`${this.baseUrl}la-spatial-source-retrive/su_id=${su_id}/`, {
      headers: this.h(),
    });
  }

  getLandTenureInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}ownership-rights-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getltAssesAndTaxInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}tax-assess-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getZoningInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}lnd-zoning-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getPhysicalEnvInfo(su_id: any) {
    return this.http.get(`${this.baseUrl}lnd-physical-env/su_id=${su_id}/`, { headers: this.h() });
  }

  // =============================================================================
  // LAND TAB — PATCH / UPDATE
  // =============================================================================

  updateAdministrativeInfo(su_id: any, data: any, tab: any) {
    const filteredData = this.filterKeys(data, [
      'sl_ba_unit_type',
      'sl_ba_unit_name',
      'pd',
      'dist',
      // gnd_id intentionally excluded: auto-derived from parcel geometry on the backend
      'eletorate',
      // local_auth removed: now derived read-only from sl_elect_local_auth lookup (keyed by GND)
      'remark',
      'access_road',
      'postal_ad_lnd',
      'ass_div',
      'no_floors',
      'house_hold_no',
      'sl_land_type',
      'administrative_type',
      'land_name',
      'registration_date',
      'parcel_status',
      // Relationship & tenure fields — backend reads these directly from request.data
      'tenure_type',
      'adjacent_parcels',
      'parent_parcel',
      'child_parcels',
      'part_of_estate',
    ]);
    return this.http.patch(`${this.baseUrl}lnd-admin-info/update/su_id=${su_id}/`, filteredData, {
      headers: this.h(),
    });
  }

  updateLandOverviewInfo(su_id: any, data: any, tab: any) {
    const filteredData = this.filterKeys(data, [
      'dimension_2d_3d',
      'area',
      'perimeter',
      'boundary_type',
      'crs',
      'ext_landuse_type',
      'ext_landuse_sub_type',
      'reference_coordinate',
    ]);
    return this.http.patch(
      `${this.baseUrl}land-overview-info/update/su_id=${su_id}/`,
      filteredData,
      { headers: this.h() },
    );
  }

  updateITUtilInfo(su_id: any, data: any, tab: any) {
    const filteredData = this.filterKeys(data, [
      'drainage_system',
      'electricity',
      'garbage_disposal',
      'sanitation_gully',
      'sanitation_sewer',
      'water_supply',
    ]);
    return this.http.patch(`${this.baseUrl}lnd-utinet-info/update/su_id=${su_id}/`, filteredData, {
      headers: this.h(),
    });
  }

  updateLandTenureInfo(su_id: any, data: any, tabs: any) {
    const filteredData = this.filterKeys(data, [
      'drainage_system',
      'electricity',
      'garbage_disposal',
      'sanitation_gully',
      'sanitation_sewer',
      'water_supply',
    ]);
    filteredData['user_id'] = this.userService.getUser()?.user_id;
    filteredData['category'] = tabs;
    return this.http.patch(`${this.baseUrl}utinet-info/update/su_id=${su_id}/`, filteredData, {
      headers: this.h(),
    });
  }

  updateTaxAndAssessmentInfo(su_id: any, data: any, type: string) {
    const filteredData = this.filterKeys(data, [
      'assessment_annual_value',
      'assessment_no',
      'assessment_percentage',
      'date_of_valuation',
      'outstanding_balance',
      'property_type',
      'tax_date',
      'tax_annual_value',
      'tax_type',
      'tax_percentage',
      'year_of_assessment',
      'land_value',
      'market_value',
      'tax_status',
    ]);
    if (data.tax_date) filteredData['tax_date'] = data.tax_date;
    if (data.date_of_valuation) filteredData['date_of_valuation'] = data.date_of_valuation;
    return this.http.patch(`${this.baseUrl}tax-assess-info/update/su_id=${su_id}/`, filteredData, {
      headers: this.h(),
    });
  }

  updateLandMetadata(su_id: any, data: any) {
    const filteredData = this.filterKeys(data, [
      'spatial_source_type',
      'source_id',
      'description',
      'date_accept',
      'surveyor_name',
    ]);
    return this.http.patch(
      `${this.baseUrl}la-spatial-source-update/su_id=${su_id}/`,
      filteredData,
      { headers: this.h() },
    );
  }

  postSpatialSource(formData: FormData): Observable<any> {
    return this.http.post(`${this.baseUrl}la-spatial-source/`, formData, {
      headers: this.h(false),
    });
  }

  updateZoningInfo(su_id: any, data: any) {
    return this.http.patch(`${this.baseUrl}lnd-zoning-info/update/su_id=${su_id}/`, data, {
      headers: this.h(),
    });
  }

  updatePhysicalEnvInfo(su_id: any, data: any) {
    return this.http.patch(`${this.baseUrl}lnd-physical-env/update/su_id=${su_id}/`, data, {
      headers: this.h(),
    });
  }

  // =============================================================================
  // BUILDING TAB — GET
  // =============================================================================

  getBuildingSummaryDetails(su_id_value: any) {
    return this.http.get(`${this.baseUrl}bld-summary/su_id=${su_id_value}/`, { headers: this.h() });
  }

  getBuildingOverViewInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}bld-overview-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getBuildingAdministrativeInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}bld-admin-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getBAUnitID(su_id_value: any) {
    return this.http.get(`${this.baseUrl}ba-unit-id/su_id=${su_id_value}/`, { headers: this.h() });
  }

  getBuildItInfo(su_id_value: any) {
    return this.http.get(`${this.baseUrl}bld-utinet-info/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  // =============================================================================
  // BUILDING UNITS (Strata / Apartment — layer_id=12)
  // =============================================================================

  /**
   * List all apartment units (layer_id=12) that are children of a building.
   * Returns { count: number, units: BuildingUnitDto[] }
   */
  getBuildingUnits(parentSuId: string | number): Observable<any> {
    this.loadFromStorage();
    return this.http.get(`${this.baseUrl}bld-units/?parent_su_id=${parentSuId}`, {
      headers: this.h(),
    });
  }

  /** Retrieve a single apartment unit by its su_id. */
  getBuildingUnit(suId: string | number): Observable<any> {
    this.loadFromStorage();
    return this.http.get(`${this.baseUrl}bld-unit/su_id=${suId}/`, { headers: this.h() });
  }

  /**
   * Create a new apartment unit.
   * Minimum payload: { parent_su_id, apt_name, floor_no }
   */
  createBuildingUnit(data: Record<string, any>): Observable<any> {
    this.loadFromStorage();
    return this.http.post(`${this.baseUrl}bld-unit/create/`, data, { headers: this.h() });
  }

  /** Patch admin and/or utility attributes of an apartment unit. */
  updateBuildingUnit(suId: string | number, data: Record<string, any>): Observable<any> {
    this.loadFromStorage();
    return this.http.patch(`${this.baseUrl}bld-unit/update/su_id=${suId}/`, data, {
      headers: this.h(),
    });
  }

  // =============================================================================
  // BUILDING TAB — PATCH / UPDATE
  // =============================================================================

  updateBuildingAdministrativeInfo(su_id: any, data: any, tab: any) {
    const filteredData = this.filterKeys(data, [
      'sl_ba_unit_type',
      'sl_ba_unit_name',
      'pd',
      'dist',
      'dsd',
      'gnd_id',
      'eletorate',
      'local_auth',
      'remark',
      'access_road',
      'postal_ad_lnd',
      'ass_div',
      'no_floors',
      'house_hold_no',
      'sl_land_type',
      'status',
      'bld_property_type',
      'postal_ad_build',
      'administrative_type',
      'building_name',
      'registration_date',
      'construction_year',
      'structure_type',
      'condition',
      'wall_type',
      'ext_builduse_type',
      'ext_builduse_sub_type',
    ]);
    return this.http.patch(`${this.baseUrl}bld-admin-info/update/su_id=${su_id}/`, filteredData, {
      headers: this.h(),
    });
  }

  updateBuildOverviewInfo(su_id: any, data: any, tab: any) {
    const filteredData = this.filterKeys(data, [
      'dimension_2d_3d',
      'area',
      'reference_coordinate',
      'hight',
      'surface_relation',
      'ext_builduse_type',
      'ext_builduse_sub_type',
      'roof_type',
      'wall_type',
      'no_floors',
    ]);
    return this.http.patch(
      `${this.baseUrl}bld-overview-info/update/su_id=${su_id}/`,
      filteredData,
      { headers: this.h() },
    );
  }

  updateBuildingITUtilInfo(su_id: any, data: any, tab: any) {
    const filteredData = this.filterKeys(data, [
      'elec',
      'water',
      'water_drink',
      'tele',
      'internet',
      'sani_sewer',
      'sani_gully',
      'garbage_dispose',
      'drainage',
      'expired_date',
      'issued_date',
    ]);
    if (data.expired_date) filteredData['expired_date'] = data.expired_date;
    if (data.issued_date) filteredData['issued_date'] = data.issued_date;
    return this.http.patch(`${this.baseUrl}bld-utinet-info/update/su_id=${su_id}/`, filteredData, {
      headers: this.h(),
    });
  }

  // =============================================================================
  // RRR (Rights, Restrictions, Responsibilities)
  // =============================================================================

  getRRRData(su_id_value: any) {
    return this.http.get(`${this.baseUrl}rrr_data_get/?su_id=${su_id_value}`, {
      headers: this.h(),
    });
  }

  /** Alias — same endpoint as getRRRData, kept for backward compatibility. */
  getExistingAdminSourceData(su_id: any) {
    return this.getRRRData(su_id);
  }

  getRrrByFeatureId(featureId: string): Observable<any> {
    return this.http.get(`${this.baseUrl}rrr-by-featureid/feature_id=${featureId}/`, {
      headers: this.h(),
    });
  }

  getRRRRestrictions(ba_unit_id: number | string) {
    return this.http.get(`${this.baseUrl}rrr-restrictions/ba_unit_id=${ba_unit_id}/`, {
      headers: this.h(),
    });
  }

  postRRRRestriction(ba_unit_id: number | string, data: any) {
    return this.http.post(`${this.baseUrl}rrr-restrictions/ba_unit_id=${ba_unit_id}/`, data, {
      headers: this.h(),
    });
  }

  deleteRRRRestriction(ba_unit_id: number | string, id: number | string) {
    return this.http.delete(`${this.baseUrl}rrr-restrictions/ba_unit_id=${ba_unit_id}/`, {
      headers: this.h(),
      body: { id },
    });
  }

  getRRRResponsibilities(ba_unit_id: number | string) {
    return this.http.get(`${this.baseUrl}rrr-responsibilities/ba_unit_id=${ba_unit_id}/`, {
      headers: this.h(),
    });
  }

  postRRRResponsibility(ba_unit_id: number | string, data: any) {
    return this.http.post(`${this.baseUrl}rrr-responsibilities/ba_unit_id=${ba_unit_id}/`, data, {
      headers: this.h(),
    });
  }

  deleteRRRResponsibility(ba_unit_id: number | string, id: number | string) {
    return this.http.delete(`${this.baseUrl}rrr-responsibilities/ba_unit_id=${ba_unit_id}/`, {
      headers: this.h(),
      body: { id },
    });
  }

  postAdminSource(formData: FormData | Record<string, any>): Observable<any> {
    const userId = this.userService.getUser()?.user_id;
    if (formData instanceof FormData) {
      formData.append('user_id', String(userId ?? ''));
      return this.http.post(`${this.baseUrl}rrr_data_save/`, formData, { headers: this.h(false) });
    }
    // Plain JSON object path (used by rrr-panal dialog)
    return this.http.post(
      `${this.baseUrl}rrr_data_save/`,
      { ...formData, user_id: userId },
      {
        headers: this.h(true),
      },
    );
  }

  patchAdminSource(adminSourceId: number, formData: FormData): Observable<any> {
    return this.http.patch(`${this.baseUrl}admin-source/update/${adminSourceId}/`, formData, {
      headers: this.h(false),
    });
  }

  /** Update an existing LADM RRR entry (BA unit + primary RRR + party role + admin source). */
  patchRRREntry(baUnitId: number, data: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}rrr/update/${baUnitId}/`, data, { headers: this.h() });
  }

  /** Upload an additional document to an existing BA unit. */
  postRRRDocument(baUnitId: number, formData: FormData): Observable<any> {
    return this.http.post(`${this.baseUrl}rrr-add-document/ba_unit_id=${baUnitId}/`, formData, {
      headers: this.h(false),
    });
  }

  /** Delete an additional document link (la_rrr_document row + its admin source). */
  deleteRRRDocument(docLinkId: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}rrr-remove-document/${docLinkId}/`, {
      headers: this.h(),
    });
  }

  deleteRrr(id: string): Observable<any> {
    return this.http.patch(
      `${this.baseUrl}ba_unit/update/${id}/`,
      { status: false },
      { headers: this.h() },
    );
  }

  getRRRFile(url: string): Observable<any> {
    return this.http.get(url, { headers: this.h() });
  }

  /** Issue #8: Soft-delete (terminate) a single RRR and write an audit record. */
  terminateRRR(rrrId: number): Observable<any> {
    return this.http.patch(`${this.baseUrl}rrr/terminate/${rrrId}/`, {}, { headers: this.h() });
  }

  /** Issue #8: Fetch the full audit history for a parcel (by su_id). */
  getRRRHistory(suId: string | number): Observable<any> {
    return this.http.get(`${this.baseUrl}rrr-history/?su_id=${suId}`, { headers: this.h() });
  }

  getParcelHistory(suId: string | number): Observable<any> {
    return this.http.get(`${this.baseUrl}parcel-history/su_id=${suId}/`, { headers: this.h() });
  }

  /** Search soft-deleted parcels (no longer on the map) by su_id or label. */
  searchDeletedParcels(query: string): Observable<any> {
    return this.http.get(`${this.baseUrl}deleted-parcels/?q=${encodeURIComponent(query)}`, {
      headers: this.h(),
    });
  }

  restoreParcelHistory(historyId: string | number, payload: { reason: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}parcel-history/restore/id=${historyId}/`, payload, {
      headers: this.h(),
    });
  }

  restoreParcelGeometry(
    historyId: string | number,
    payload: { reason: string; cancel_children?: boolean },
  ): Observable<any> {
    return this.http.post(
      `${this.baseUrl}parcel-history/restore-geometry/id=${historyId}/`,
      payload,
      { headers: this.h() },
    );
  }

  restoreParcelRRR(historyId: string | number, payload: { reason: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}parcel-history/restore-rrr/id=${historyId}/`, payload, {
      headers: this.h(),
    });
  }

  undoParcelRectification(eventId: string | number, payload: { reason: string }): Observable<any> {
    return this.http.post(
      `${this.baseUrl}parcel-history/undo-rectification/event=${eventId}/`,
      payload,
      { headers: this.h() },
    );
  }

  getGeoTags(): Observable<any[]> {
    return this.http.get<any[]>(`${this.baseUrl}geotags/`, { headers: this.h() });
  }

  createGeoTag(payload: {
    tag_type: string;
    label: string;
    longitude: number;
    latitude: number;
    note?: string | null;
  }): Observable<any> {
    return this.http.post(`${this.baseUrl}geotags/`, payload, { headers: this.h() });
  }

  updateGeoTag(
    tagId: number | string,
    payload: { status?: boolean; note?: string | null },
  ): Observable<any> {
    return this.http.patch(`${this.baseUrl}geotags/${tagId}/`, payload, { headers: this.h() });
  }

  deleteGeoTag(tagId: number | string): Observable<any> {
    return this.http.delete(`${this.baseUrl}geotags/${tagId}/`, { headers: this.h() });
  }

  // =============================================================================
  // LOOKUP DROPDOWNS
  // =============================================================================

  loadLandUseCategories() {
    return this.http.get(`${this.baseUrl}lst-ec-extlandusetype-28/`, { headers: this.h() });
  }

  loadSubCategory() {
    return this.http.get(`${this.baseUrl}lst-ec-extlandusesubtype-29/`, { headers: this.h() });
  }

  getWaterSupply() {
    return this.http.get(`${this.baseUrl}lst-su-sl-water-22/`, { headers: this.h() });
  }

  getSanitationSewerage() {
    return this.http.get(`${this.baseUrl}lst-su-sl-sanitation-23/`, { headers: this.h() });
  }

  // ── Physical & Environmental dropdowns (Land panel) ────────────────────────
  getVegetationOptions() {
    return this.http.get(`${this.baseUrl}lst-su-sl-vegetation-42/`, { headers: this.h() });
  }

  getElectricityOptions() {
    return this.http.get(`${this.baseUrl}lst-su-sl-electricity-43/`, { headers: this.h() });
  }

  getDrainageOptions() {
    return this.http.get(`${this.baseUrl}lst-su-sl-drainage-44/`, { headers: this.h() });
  }

  getGullyOptions() {
    return this.http.get(`${this.baseUrl}lst-su-sl-gully-45/`, { headers: this.h() });
  }

  getGarbageOptions() {
    return this.http.get(`${this.baseUrl}lst-su-sl-garbage-46/`, { headers: this.h() });
  }

  loadRoofTypes() {
    return this.http.get(`${this.baseUrl}lst-su-sl-roof-type-24/`, { headers: this.h() });
  }

  loadTelecomTypes() {
    return this.http.get(`${this.baseUrl}lst-tele-providers-38/`, { headers: this.h() });
  }

  loadInternetTypes() {
    return this.http.get(`${this.baseUrl}lst-int-providers-39/`, { headers: this.h() });
  }

  loadWallType() {
    return this.http.get(`${this.baseUrl}lst-su-sl-wall-type-25/`, { headers: this.h() });
  }

  loadMortgageTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-mortgagetype-13/`, { headers: this.h() });
  }

  getSourceTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-administrativesourcetype-16/`, {
      headers: this.h(),
    });
  }

  getUnitTypes() {
    return this.http.get(`${this.baseUrl}lst-la-baunittype-18/`, { headers: this.h() });
  }

  GNDListdData() {
    return this.http.get(`${this.baseUrl}lst-gnd-area/`, { headers: this.h() });
  }

  loadPartySubTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-party-type-1/`, { headers: this.h() });
  }

  loadOwnershipTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-righttype-9/`, { headers: this.h() });
  }

  loadGenderTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-gendertype-8/`, { headers: this.h() });
  }

  getAuthorityTypes() {
    return this.http.get(`${this.baseUrl}lst-org-name-40/`, { headers: this.h() });
  }

  getReligionTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-religions-7/`, { headers: this.h() });
  }

  grtMarriedStatus() {
    return this.http.get(`${this.baseUrl}lst-sl-married-status-6/`, { headers: this.h() });
  }

  getHelthdTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-health-status-5/`, { headers: this.h() });
  }

  getRaceTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-race-4/`, { headers: this.h() });
  }

  getEducationLevelTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-education-level-3/`, { headers: this.h() });
  }

  getGroupTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-group_party_type-41/`, { headers: this.h() });
  }

  loadRightshareTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-rightsharetype-14/`, { headers: this.h() });
  }

  loadRightPartyRoleTypes() {
    return this.http.get(`${this.baseUrl}lst-sl-partyroletype-2/`, { headers: this.h() });
  }

  loadBuildingCategories() {
    return this.http.get(`${this.baseUrl}lst-ec-extbuildusetype-32/`, { headers: this.h() });
  }

  loadBuildingSubCategory() {
    return this.http.get(`${this.baseUrl}lst-ec-extbuildusesubtype-33/`, { headers: this.h() });
  }

  getAssessWardList() {
    return this.http.get(`${this.baseUrl}assess_ward_lst/`, { headers: this.h() });
  }

  getDistList() {
    return this.http.get(`${this.baseUrl}dist-list/`, { headers: this.h() });
  }

  // =============================================================================
  // PARTY
  // =============================================================================

  getCivilianPartyData(data: any) {
    return this.http.post(
      `${this.baseUrl}sl-party-data/`,
      {
        user_id: this.userService.getUser()?.user_id,
        ext_pid_type: data.party_registration_type,
        ext_pid: data.registration_number,
      },
      { headers: this.h() },
    );
  }

  getPartyDataFromPID(data: any) {
    return this.http.post(
      `${this.baseUrl}sl-party-data-pid/`,
      { pid: data.registration_number },
      { headers: this.h() },
    );
  }

  getGroupNames() {
    return this.http.get(`${this.baseUrl}sl-party-data-type/Group/`, { headers: this.h() });
  }

  getMinisrtTypes() {
    return this.http.get(`${this.baseUrl}sl-party-data-type/Ministry/`, { headers: this.h() });
  }

  pathchCivilianPartyForm(type: string, value: any, id?: any): Observable<any> {
    value.done_by = this.userService.getUser()?.user_id;
    if (type === 'update' && id) {
      return this.http.patch(`${this.baseUrl}sl-party/update/pid=${id}/`, value, {
        headers: this.h(),
      });
    } else if (type === 'create') {
      return this.http.post(`${this.baseUrl}sl-party/`, value, { headers: this.h() });
    }
    return throwError(() => new Error('Invalid operation type'));
  }

  // =============================================================================
  // IMAGES / FILES
  // =============================================================================

  uploadImage(formData: FormData) {
    return this.http.post(`${this.baseUrl}attrib-image-upload/`, formData, {
      headers: this.h(false),
    });
  }

  getParsalImage(su_id: any): Observable<any> {
    return this.http.get(`${this.baseUrl}attrib-image-retrive/su_id=${su_id}/`, {
      headers: this.h(),
      responseType: 'blob',
    });
  }

  deleteParcelImage(su_id_value: any) {
    return this.http.delete(`${this.baseUrl}attrib-image-delete/su_id=${su_id_value}/`, {
      headers: this.h(),
    });
  }

  getPDF(file_path: any) {
    return this.http.get(file_path, { headers: this.h(), responseType: 'blob' });
  }

  getCreatedByDetails(su_id_value: any) {
    return this.http.post(
      `${this.baseUrl}create_by/`,
      { su_id: su_id_value },
      { headers: this.h() },
    );
  }

  // =============================================================================
  // GND / ORG AREA
  // =============================================================================

  getGndData(): Observable<GeoJSON.FeatureCollection> {
    return this.http.get<GeoJSON.FeatureCollection>(`${this.baseUrl}org_area/`, {
      headers: this.h(),
    });
  }

  getCurrentLocation() {
    return this.http.get(`${this.baseUrl}org_loc_get/`, { headers: this.h() });
  }

  getOrgAreas(pd: string): Observable<AreaRow[]> {
    return this.http.get<AreaRow[]>(`${this.baseUrl}pd-data/${pd}/`, { headers: this.h() });
  }

  updateOrgArea(id: string, data: { gid: number }[]): Observable<any> {
    const payload = { org_area: data.map((item) => item.gid) || null };
    return this.http.patch(`${this.baseUrl}org-area/update/org_id=${id}/`, payload, {
      headers: this.h(),
    });
  }

  getOrganizationAreaById(id: string) {
    return this.http.get(`${this.baseUrl}org-area-get/org_id=${id}/`, { headers: this.h() });
  }

  // =============================================================================
  // ADMIN — USERS, ROLES, LAYERS, ORGANIZATIONS
  // =============================================================================

  getAdminUsers() {
    return this.http.get(`${this.baseUrl}list/`, { headers: this.h() });
  }

  createNewUser(formData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}create/`, formData, { headers: this.h() });
  }

  editUser(document_id: any, formData: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}update/user_id=${document_id}/`, formData, {
      headers: this.h(),
    });
  }

  getAdminRoleUsers() {
    return this.http.get(`${this.baseUrl}list-add-user-roles/`, { headers: this.h() });
  }

  getRolesList() {
    return this.http.get(`${this.baseUrl}user-roles-get-admin/`, { headers: this.h() });
  }

  createRole(formData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}user-roles/`, formData, { headers: this.h() });
  }

  addUsersToRole(formData: any, role_id: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}user-roles/update/role_id=${role_id}/`, formData, {
      headers: this.h(),
    });
  }

  deleteRole(role_id: any): Observable<any> {
    return this.http.delete(`${this.baseUrl}user-roles/delete/role_id=${role_id}/`, {
      headers: this.h(),
    });
  }

  editUserPermisions(document_id: any, formData: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}role-permission/update/id=${document_id}/`, formData, {
      headers: this.h(),
    });
  }

  getAdminLayers(): Observable<any> {
    return this.http.get(`${this.baseUrl}layerdata_get_admin_panel/`, { headers: this.h() });
  }

  createLayer(formData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}layerdata/`, formData, { headers: this.h() });
  }

  updateLayer(formData: any, id: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}layerdata/update/id=${id}/`, formData, {
      headers: this.h(),
    });
  }

  deleteLayer(formData: any, id: any): Observable<any> {
    return this.http.delete(`${this.baseUrl}layerdata/delete/id=${id}/`, { headers: this.h() });
  }

  getOrganizationsList() {
    return this.http.get(`${this.baseUrl}sl-orgnization/`, { headers: this.h() });
  }

  getOrganizationById(id: string) {
    return this.http.get(`${this.baseUrl}sl-orgnization/org_id=${id}/`, { headers: this.h() });
  }

  createNewOrganization(formData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}sl-orgnization/`, formData, { headers: this.h() });
  }

  editOrganization(document_id: any, formData: any): Observable<any> {
    return this.http.patch(
      `${this.baseUrl}sl-organization/update/org_id=${document_id}/`,
      formData,
      { headers: this.h() },
    );
  }

  getOrganizationLocationById(id: string) {
    return this.http.get(`${this.baseUrl}org_loc/org_id=${id}/`, { headers: this.h() });
  }

  editOrganizationLocation(document_id: any, formData: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}org_loc/update/org_id=${document_id}/`, formData, {
      headers: this.h(),
    });
  }

  getDepartments(): Observable<any> {
    return this.http.get(`${this.baseUrl}sl-department-list/`, { headers: this.h() });
  }

  createDepartment(formData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}sl-department/`, formData, { headers: this.h() });
  }

  updateDepartment(formData: any, id: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}sl-department/update/id=${id}/`, formData, {
      headers: this.h(),
    });
  }

  deleteDepartment(id: any): Observable<any> {
    return this.http.delete(`${this.baseUrl}sl-department/update/id=${id}/`, { headers: this.h() });
  }

  createAssesmentWard(formData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}assess_ward_lst/`, formData, { headers: this.h() });
  }

  updateAssessmentWard(formData: any, id: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}assess_ward_update/id=${id}/`, formData, {
      headers: this.h(),
    });
  }

  getDashboardData() {
    return this.http.get(`${this.baseUrl}org_details/`, { headers: this.h() });
  }

  getAdminContactInfo() {
    return this.http.get(`${this.baseUrl}admin_acc_data/`, { headers: this.h() });
  }

  getRecentLogins() {
    return this.http.get(`${this.baseUrl}recent_logins/`, { headers: this.h() });
  }

  getUserOverview() {
    return this.http.get(`${this.baseUrl}user_overview/`, { headers: this.h() });
  }

  postPassword(password: any) {
    return this.http.post(`${this.baseUrl}check-password/`, password, { headers: this.h() });
  }

  postAdminData(admin: any): Observable<any> {
    admin.admin_id = this.userService.getUser()?.user_id;
    return this.http.post(`${this.baseUrl}reset_password/`, admin, { headers: this.h() });
  }

  // =============================================================================
  // AUTH
  // =============================================================================

  userAuthentication(): Observable<{
    is_active: boolean;
    is_role_id: boolean;
    is_token_valid: boolean;
    is_org_active: boolean;
  }> {
    const roleId = localStorage.getItem('role_id');
    if (roleId === null) {
      return throwError(() => new Error('Role ID is not set in localStorage'));
    }
    return this.http.post<{
      is_active: boolean;
      is_role_id: boolean;
      is_token_valid: boolean;
      is_org_active: boolean;
    }>(`${this.baseUrl}user-authentication/`, { role_id: parseInt(roleId) }, { headers: this.h() });
  }

  getUserDetails() {
    return this.http.get(`${this.baseUrl}me/`, { headers: this.h() });
  }

  // =============================================================================
  // DYNAMIC ATTRIBUTES
  // =============================================================================

  createDynamicAttribute(payload: {
    section_key: string;
    label: string;
    su_id: string | number;
  }): Observable<any> {
    return this.http.post(`${this.baseUrl}dynamic-attribute/`, payload, { headers: this.h() });
  }

  getDynamicAttributes(su_id: string | number, section_key: string): Observable<any[]> {
    return this.http.get<any[]>(
      `${this.baseUrl}dynamic-attribute/?su_id=${su_id}&section_key=${section_key}`,
      { headers: this.h() },
    );
  }

  updateDynamicAttributeValue(payload: {
    attribute_id: number;
    su_id: string | number;
    value: string;
  }): Observable<any> {
    return this.http.post(`${this.baseUrl}dynamic-attribute-value/`, payload, {
      headers: this.h(),
    });
  }

  // =============================================================================
  // 3D / CITYJSON
  // =============================================================================

  /**
   * Fetch the CityJSON document(s) for a given building/parcel su_id.
   * The backend `city_json` table is keyed by `su_id`; passing the filter
   * returns only that building's model (previously this ignored the id and
   * returned the whole list).
   */
  load3DData(featureId: string | number) {
    return this.http.get(`${this.baseUrl}cityjson/?su_id=${featureId}`, {
      headers: this.h(),
    });
  }

  /** Retrieve a single stored CityJSON document by its primary key. */
  getCityJsonById(cityjsonId: string | number) {
    return this.http.get(`${this.baseUrl}cityjson/${cityjsonId}/`, {
      headers: this.h(),
    });
  }

  /**
   * Import an IFC / CityJSON building onto a parcel.
   * Runs the server-side cadastral converter (footprint + per-unit 3D solids)
   * and creates the LADM building + child-unit records.
   *
   * @param payload.file          the .ifc | .json file
   * @param payload.parentSuId    survey_rep.id of the target parcel
   * @param payload.anchorLon/Lat optional manual anchor (defaults: parcel centroid)
   * @param payload.rotationDeg   optional CCW rotation about vertical (default 0)
   * @param payload.scale         optional uniform scale (default 1)
   * @param payload.baseZ         optional ground elevation (default 0)
   */
  import3DObject(payload: {
    file: File;
    parentSuId: string | number;
    /** >=2 control-point pairs { local:[x,y,z], lon, lat }; if given, the
     *  server solves rotation+scale and ignores rotationDeg/scale/anchor. */
    anchorPairs?: Array<{ local: (number | null)[]; lon: number | null; lat: number | null }>;
    anchorLon?: number;
    anchorLat?: number;
    rotationDeg?: number;
    scale?: number;
    baseZ?: number;
  }) {
    const form = new FormData();
    form.append('file', payload.file);
    form.append('parent_su_id', String(payload.parentSuId));
    if (payload.anchorPairs && payload.anchorPairs.length >= 2) {
      form.append('anchor_pairs', JSON.stringify(payload.anchorPairs));
    }
    if (payload.anchorLon != null) form.append('anchor_lon', String(payload.anchorLon));
    if (payload.anchorLat != null) form.append('anchor_lat', String(payload.anchorLat));
    if (payload.rotationDeg != null) form.append('rotation_deg', String(payload.rotationDeg));
    if (payload.scale != null) form.append('scale', String(payload.scale));
    if (payload.baseZ != null) form.append('base_z', String(payload.baseZ));

    // h(false) = Authorization only; the browser sets the multipart boundary.
    return this.http.post(`${this.baseUrl}cityjson/import/`, form, {
      headers: this.h(false),
      reportProgress: true,
      observe: 'events',
    });
  }

  /**
   * City-3D feed: imported 3D buildings within the login user's organisation
   * area (server-filtered by GND). Lightweight rows
   * (`{su_id, parent_su_id, gnd_id, name, cityjson_id, centroid}`) — no geometry.
   *
   * @param parcelSuId optional — restrict to buildings on one parcel (parcel-
   *   focused "View as 3D" mode). The response then also includes `parcel`
   *   ({ su_id, geojson, centroid }) so the viewer can lay the reused parcel
   *   fabric as the ground plane.
   */
  listAdminArea3DBuildings(parcelSuId?: number | string) {
    const qs = parcelSuId != null ? `?parcel_su_id=${parcelSuId}` : '';
    return this.http.get<{
      count: number;
      buildings: any[];
      parcel: any;
      parcels?: Array<{ su_id: number; geojson: any }>;
      parcels_capped?: boolean;
    }>(`${this.baseUrl}cityjson/admin-area/${qs}`, { headers: this.h() });
  }

  /**
   * Search imported 3D buildings + units by label / apartment name /
   * cadastral id, scoped to the user's area. Returns matches with a
   * `building_su_id` + `centroid` for camera fly-to.
   */
  search3DObjects(q: string) {
    const term = encodeURIComponent(q ?? '');
    return this.http.get<{ count: number; results: any[] }>(
      `${this.baseUrl}cityjson/search/?q=${term}`,
      { headers: this.h() },
    );
  }

  // =============================================================================
  // P4b — LSBU (apartment / common-space) composition
  // =============================================================================

  /**
   * List a building's room-units for the Unit Composition picker:
   * `{ pool: [...unassigned units], lsbus: [...existing LSBUs] }`.
   */
  listBuildingUnits(buildingSuId: number | string) {
    return this.http.get<{
      building_su_id: number;
      pool: any[];
      lsbus: any[];
      pool_count: number;
      lsbu_count: number;
    }>(`${this.baseUrl}bld-3d/units/?building_su_id=${buildingSuId}`, {
      headers: this.h(),
    });
  }

  /**
   * Group selected room-units into ONE Legal Space Building Unit.
   * Private types (RESIDENTIAL/COMMERCIAL) require a user-entered `cadastralId`;
   * common types (CIRCULATION/SERVICE/PARKING/AMENITY) do not.
   */
  composeLsbu(payload: {
    buildingSuId: number;
    unitSuIds: number[];
    buildingUnitType: string;
    cadastralId?: string;
    aptName?: string;
  }) {
    return this.http.post<{
      detail: string;
      lsbu_su_id: number;
      building_unit_type: string;
      cadastral_id: string | null;
      member_room_count: number;
      absorbed_unit_su_ids: number[];
    }>(
      `${this.baseUrl}bld-3d/lsbu/compose/`,
      {
        building_su_id: payload.buildingSuId,
        unit_su_ids: payload.unitSuIds,
        building_unit_type: payload.buildingUnitType,
        cadastral_id: payload.cadastralId,
        apt_name: payload.aptName,
      },
      { headers: this.h() },
    );
  }

  /**
   * Create an apartment / common-space LSBU up-front, with NO 3D units attached.
   * The room-less apartment becomes a first-class record the surveyor can list,
   * then assign unassigned pool units to (via {@link assignUnitsToLsbu}) and edit
   * later. Private types (RESIDENTIAL/COMMERCIAL) should carry a cadastralId.
   */
  createApartment(payload: {
    buildingSuId: number;
    buildingUnitType: string;
    aptName?: string;
    cadastralId?: string;
    floorNo?: number;
  }) {
    return this.http.post<{
      detail?: string;
      su_id?: number;
      new_su_id?: number;
    }>(
      `${this.baseUrl}bld-unit/create/`,
      {
        parent_su_id: payload.buildingSuId,
        building_unit_type: payload.buildingUnitType,
        apt_name: payload.aptName,
        cadastral_id: payload.cadastralId,
        floor_no: payload.floorNo,
        component_units: [],
      },
      { headers: this.h() },
    );
  }

  /**
   * Fold one or more unassigned pool room-units into an EXISTING apartment.
   * Unions their rooms + 3D solids into the apartment and marks them ABSORBED.
   */
  assignUnitsToLsbu(payload: { buildingSuId: number; lsbuSuId: number; unitSuIds: number[] }) {
    return this.http.post<{
      detail: string;
      lsbu_su_id: number;
      building_unit_type: string;
      member_room_count: number;
      absorbed_unit_su_ids: number[];
    }>(
      `${this.baseUrl}bld-3d/lsbu/assign/`,
      {
        building_su_id: payload.buildingSuId,
        lsbu_su_id: payload.lsbuSuId,
        unit_su_ids: payload.unitSuIds,
      },
      { headers: this.h() },
    );
  }

  /** Edit an existing apartment's metadata (label / type / cadastral ID). */
  updateApartment(
    suId: number,
    changes: { aptName?: string; buildingUnitType?: string; cadastralId?: string },
  ) {
    const body: Record<string, any> = {};
    if (changes.aptName !== undefined) body['apt_name'] = changes.aptName;
    if (changes.buildingUnitType !== undefined)
      body['building_unit_type'] = changes.buildingUnitType;
    if (changes.cadastralId !== undefined) body['cadastral_id'] = changes.cadastralId;
    return this.http.patch<{ detail: string }>(
      `${this.baseUrl}bld-unit/update/su_id=${suId}/`,
      body,
      { headers: this.h() },
    );
  }
}
