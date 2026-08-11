import {
  Component,
  EventEmitter,
  HostBinding,
  Output,
  inject,
  signal,
  NgZone,
  DestroyRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { Feature } from 'ol';
import { Geometry, Polygon, MultiPolygon } from 'ol/geom';
import { getArea, getLength } from 'ol/sphere';
import { forkJoin, of } from 'rxjs';
import { catchError, finalize, switchMap } from 'rxjs/operators';
import {
  LandParcelInfo,
  createDefaultLandParcel,
  BoundaryType,
  LandUse,
  ParcelStatus,
  ParcelType,
  TenureType,
  SoilType,
  ZoningCategory,
  RightType,
  AccuracyLevel,
  SurveyMethod,
  RRRInfo,
  RRREntry,
  RestrictionType,
  ResponsibilityType,
  ParcelIdentification,
  ParcelSpatial,
  ParcelPhysical,
  ParcelZoning,
  ParcelValuation,
  ParcelRelationships,
  ParcelMetadata,
} from '../../models/land-parcel.model';
import {
  BuildingInfo,
  BuildingSummary,
  BuildingUnit,
  SpatialInfo,
  PhysicalAttributes,
  UtilityInfo,
  TaxValuation,
  RelationshipsTopology,
  MetadataQuality,
  LegalStatus,
  PrimaryUse,
  LodLevel,
  ElevationRef,
  CRS,
  StructureType,
  Condition,
  RoofType,
  TopologyStatus,
  UnitType,
  AccessType,
} from '../../models/building-info.model';
import { APIsService } from '../../services/api.service';
import { DrawService, SelectedFeatureInfo } from '../../services/draw.service';
import { MapService } from '../../services/map.service';
import { NotificationService } from '../../services/notifications.service';
import { PermissionService } from '../../services/permissions.service';
import { SidebarControlService } from '../../services/sidebar-control.service';
import { LandSectionPermissions, BuildingSectionPermissions } from '../../core/constant';
import { BuildingInfoPanelComponent } from './building-info-panel/building-info-panel.component';
import { HomeTabComponent } from './home-tab/home-tab.component';
import { LandInfoPanelComponent } from './land-info-panel/land-info-panel.component';
import {
  GenerateReportComponent,
  GenerateReportData,
} from '../dialogs/generate-report/generate-report.component';

type SidebarTab = 'home' | 'land' | 'building';
type LandParcelSaveRequest = LandParcelInfo & { __dirtyFields?: string[] };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-side-panel',
  standalone: true,
  imports: [BuildingInfoPanelComponent, HomeTabComponent, LandInfoPanelComponent],
  templateUrl: './side-panel.component.html',
  styleUrl: './side-panel.component.css',
})
export class SidePanelComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);
  private destroyRef = inject(DestroyRef);

  @Output() emitExtend = new EventEmitter<boolean>();

  selected_feature_ID: any = '';
  selected_layer_ID: any = '';
  selected_featureInfo: SelectedFeatureInfo | null = null;

  private fetchedRRRBaUnitIds = new Set<number>();
  private fetchedRRRMap = new Map<string, number>(); // rrrId (BU-xxx) → actual backend rrr_id

  // Sidebar state (signals — matching 3D Cadastre pattern)
  activeSidebarTab = signal<SidebarTab>('home');
  isSidebarClosed = signal(false);
  sidebarWidth = signal(340);
  // Reactive so HostBinding 'class.resizing' picks up the change and
  // disables the width transition during interactive drag.
  resizingSig = signal(false);

  /**
   * Host width — the single source of truth for the sidebar slot.
   * The outer `.side-panel-container` in main.component is just a
   * flex-shrink:0 wrapper; it follows whatever width we set here.
   */
  @HostBinding('style.width.px')
  get hostWidthPx(): number {
    if (this.isSidebarClosed()) return 30;
    if (this.extendWidth) return 480;
    return this.sidebarWidth();
  }

  /** Applied to :host while the user is dragging the resize handle. */
  @HostBinding('class.resizing')
  get isResizingHost(): boolean {
    return this.resizingSig();
  }

  // Data signals for info panels
  currentLandParcelInfo = signal<LandParcelInfo | null>(null);
  currentBuildingInfo = signal<BuildingInfo | null>(null);
  buildingModelLoaded = signal(false);
  sectionPerms = signal<Record<number, any>>({});
  isSavingLandParcel = signal(false);
  isSavingBuilding = signal(false);

  extendWidth = false;

  constructor(
    private mapService: MapService,
    private drawService: DrawService,
    private notificationService: NotificationService,
    private sidebarService: SidebarControlService,
    private apiService: APIsService,
    private dialog: MatDialog,
    private permissionService: PermissionService,
  ) {
    // Handle feature selection changes
    this.drawService.selectedFeatureInfo$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((info) => {
        if (!info || (Array.isArray(info) && info.length === 0) || info.length > 1) {
          this.selected_feature_ID = null;
          this.currentLandParcelInfo.set(null);
          this.currentBuildingInfo.set(null);
          this.buildingModelLoaded.set(false);
          this.activeSidebarTab.set('home');
          this.removeExtend();
          return;
        }

        const featureInfo = Array.isArray(info) ? info[0] : info;

        if (featureInfo.featureId == null) {
          return;
        }

        // feature_Id is still a UUID string — feature drawn but not yet saved to DB.
        // Skip all API calls to avoid the "expected a number but got UUID" backend error.
        console.log(
          '[SidePanel] featureId:',
          featureInfo.featureId,
          '| type:',
          typeof featureInfo.featureId,
        );
        if (typeof featureInfo.featureId !== 'number') {
          this.selected_featureInfo = featureInfo;
          this.selected_feature_ID = featureInfo.featureId || '';
          this.selected_layer_ID = featureInfo.layerId || '';
          if (featureInfo.layerId === 3 || featureInfo.layerId === 12) {
            this.currentLandParcelInfo.set(null);
            this.currentBuildingInfo.set(this.createBuildingFromFeature(featureInfo));
            this.buildingModelLoaded.set(true);
            this.activeSidebarTab.set('building');
          } else {
            this.currentBuildingInfo.set(null);
            this.buildingModelLoaded.set(false);
            this.currentLandParcelInfo.set(null);
            this.activeSidebarTab.set('land');
          }
          this.makeExtend();
          this.cdr.markForCheck();
          return;
        }

        this.selected_featureInfo = featureInfo;
        this.selected_feature_ID = featureInfo.featureId || '';
        this.selected_layer_ID = featureInfo.layerId || '';

        // Auto-switch tabs based on the selected layer and populate data
        switch (this.selected_layer_ID) {
          case 1:
          case 6:
            this.activeSidebarTab.set('land');
            this.currentBuildingInfo.set(null);
            this.buildingModelLoaded.set(false);
            this.currentLandParcelInfo.set(this.createLandParcelFromFeature(featureInfo));
            this.fetchAndMergeLandParcelData(featureInfo.featureId);
            this.makeExtend();
            break;
          case 3:
          case 12:
            this.activeSidebarTab.set('building');
            this.currentLandParcelInfo.set(null);
            this.currentBuildingInfo.set(this.createBuildingFromFeature(featureInfo));
            this.buildingModelLoaded.set(true);
            this.fetchAndMergeBuildingData(featureInfo.featureId);
            this.makeExtend();
            break;
          default:
            this.activeSidebarTab.set('land');
            this.currentBuildingInfo.set(null);
            this.buildingModelLoaded.set(false);
            this.currentLandParcelInfo.set(this.createLandParcelFromFeature(featureInfo));
            this.fetchAndMergeLandParcelData(featureInfo.featureId);
            this.makeExtend();
        }

        this.cdr.markForCheck();
      });

    // Handle explicit deselection
    this.drawService.deselectedFeature$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.selected_feature_ID = null;
      this.currentLandParcelInfo.set(null);
      this.currentBuildingInfo.set(null);
      this.buildingModelLoaded.set(false);
      this.activeSidebarTab.set('home');
      this.removeExtend();

      this.cdr.markForCheck();
    });

    // Handle sidebar open/close events
    this.sidebarService.isClosed$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((closed) => {
      this.isSidebarClosed.set(closed);
    });
  }

  switchTab(tab: SidebarTab): void {
    this.activeSidebarTab.set(tab);
    this.makeExtend();
  }

  ngOnInit(): void {
    this.loadSectionPermissions();
  }

  private loadSectionPermissions(): void {
    const roleId = parseInt(
      typeof window !== 'undefined' ? (localStorage.getItem('role_id') ?? '0') : '0',
      10,
    );
    if (!roleId) return;
    const allIds = [
      ...Object.values(LandSectionPermissions),
      ...Object.values(BuildingSectionPermissions),
    ];
    this.permissionService.loadPermissions(roleId, allIds).subscribe({
      next: (perms) => this.sectionPerms.set(perms),
      error: () => {
        /* keep default allow-all */
      },
    });
  }

  isTabEnabled(tab: SidebarTab): boolean {
    switch (tab) {
      case 'home':
        return true;
      case 'land':
        return true;
      case 'building':
        return true;
      default:
        return false;
    }
  }

  toggleSidebar(): void {
    this.sidebarService.toggleSidebar();
  }

  makeExtend(): void {
    this.extendWidth = true;
    this.emitExtend.emit(true);
  }

  removeExtend(): void {
    this.extendWidth = false;
    this.emitExtend.emit(false);
  }

  // ─── Sidebar Resize (from 3D Cadastre) ─────────────────────
  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.resizingSig.set(true);
    const startX = event.clientX;
    const startWidth = this.sidebarWidth();

    const onMove = (e: MouseEvent) => {
      if (!this.resizingSig()) return;
      // Sidebar is on the LEFT, resize handle on its right edge:
      // dragging the handle rightward (clientX increasing) must WIDEN
      // the sidebar, so delta = e.clientX - startX (positive = wider).
      // The original 3D-Cadastre code used `startX - e.clientX`, which
      // assumed a right-side sidebar and inverted the behaviour here.
      const delta = e.clientX - startX;
      const newWidth = Math.max(240, Math.min(600, startWidth + delta));
      this.ngZone.run(() => this.sidebarWidth.set(newWidth));
    };

    const onUp = () => {
      this.resizingSig.set(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ─── Feature → Model Mappers ─────────────────────────────

  private createLandParcelFromFeature(featureInfo: SelectedFeatureInfo): LandParcelInfo {
    const props = featureInfo.olFeature?.getProperties() || {};
    const geometry = featureInfo.olFeature?.getGeometry();
    const featureId = String(featureInfo.featureId ?? '');

    // Compute spatial properties from geometry
    let area = 0;
    let perimeter = 0;
    let geometryType = 'Polygon';
    let coordinateCount = 0;
    let centroidLon = 0;
    let centroidLat = 0;

    if (geometry) {
      geometryType = geometry.getType();
      const mapProjection = this.mapService.mapInstance?.getView().getProjection();

      if (geometry instanceof Polygon || geometry instanceof MultiPolygon) {
        area = getArea(geometry, { projection: mapProjection }) || 0;
        const ring =
          geometry instanceof Polygon
            ? geometry.getLinearRing(0)
            : geometry.getPolygon(0)?.getLinearRing(0);
        if (ring) {
          perimeter = getLength(ring, { projection: mapProjection }) || 0;
        }
      }

      const extent = geometry.getExtent();
      centroidLon = (extent[0] + extent[2]) / 2;
      centroidLat = (extent[1] + extent[3]) / 2;

      const flatCoords = (geometry as any).getFlatCoordinates?.() || [];
      const stride = (geometry as any).stride || 2;
      coordinateCount = flatCoords.length / stride;
    }

    const parcel = createDefaultLandParcel(featureId);

    // Map feature properties to identification
    parcel.identification = {
      parcelId: props['parcel_id'] || props['parcelId'] || props['id'] || featureId,
      cadastralRef: props['cadastral_ref'] || props['cadastralRef'] || props['lot_number'] || '',
      parcelType: this.resolveEnum(props['parcel_type'], ParcelType, ParcelType.LAND),
      parcelStatus: this.resolveEnum(props['status'], ParcelStatus, ParcelStatus.ACTIVE),
      landUse: this.resolveEnum(props['land_use'] || props['landUse'], LandUse, LandUse.VAC),
      tenureType: this.resolveEnum(props['tenure_type'], TenureType, TenureType.FREE),
      registrationDate: props['registration_date'] || props['created_at'] || '',
      localAuthority: props['local_authority'] || props['district'] || props['pd'] || '',
    };

    // Map spatial properties (calculated from geometry)
    parcel.spatial = {
      area: Math.round(area * 100) / 100,
      perimeter: Math.round(perimeter * 100) / 100,
      geometryType,
      boundaryType: this.resolveEnum(props['boundary_type'], BoundaryType, BoundaryType.GENERAL),
      coordinateCount,
      crs: props['crs'] || 'EPSG:4326',
      centroidLon: Math.round(centroidLon * 1000000) / 1000000,
      centroidLat: Math.round(centroidLat * 1000000) / 1000000,
    };

    // Map physical properties
    parcel.physical = {
      elevation: props['elevation'] || 0,
      slope: props['slope'] || 0,
      soilType: this.resolveEnum(props['soil_type'], SoilType, SoilType.LOAM),
      floodZone: props['flood_zone'] ?? false,
      vegetationCover: props['vegetation'] || props['vegetation_cover'] || '',
      accessRoad: props['access_road'] === 'Yes' || props['access_road'] === true,
      waterSupply: '',
      electricity: '',
      drainageSystem: '',
      sanitationSewer: '',
      sanitationGully: '',
      garbageDisposal: '',
    };

    // Map zoning properties
    parcel.zoning = {
      zoningCategory: this.resolveEnum(props['zoning'], ZoningCategory, ZoningCategory.R1),
      maxBuildingHeight: props['max_height'] || 0,
      maxCoverage: props['max_coverage'] || 0,
      maxFAR: props['max_far'] || 0,
      setbackFront: props['setback_front'] || 0,
      setbackRear: props['setback_rear'] || 0,
      setbackSide: props['setback_side'] || 0,
      specialOverlay: props['special_overlay'] || '',
    };

    // Map valuation
    parcel.valuation = {
      landValue: props['land_value'] || 0,
      marketValue: props['market_value'] || 0,
      annualTax: props['annual_tax'] || 0,
      lastAssessmentDate: props['last_assessment_date'] || '',
      taxStatus: props['tax_status'] || 'pending',
    };

    // Map relationships
    parcel.relationships = {
      buildingIds: props['building_ids'] || [],
      adjacentParcels: props['adjacent_parcels'] || '',
      parentParcel: props['parent_parcel'] || '',
      childParcels: props['child_parcels'] || '',
      partOfEstate: props['estate_id'] || '',
    };

    // Map metadata
    parcel.metadata = {
      dataQualityId: props['data_quality_id'] || parcel.metadata.dataQualityId,
      accuracyLevel: this.resolveEnum(
        props['accuracy_level'],
        AccuracyLevel,
        AccuracyLevel.ACC_TIER2,
      ),
      surveyMethod: this.resolveEnum(props['survey_method'], SurveyMethod, SurveyMethod.SURVEY_TS),
      lastUpdated: props['updated_at'] || props['last_updated'] || new Date().toISOString(),
      responsibleParty: props['responsible_party'] || props['surveyor'] || '',
      sourceDocument: props['source_document'] || '',
    };

    // Map RRR from owner property if available
    if (props['owner'] || props['owner_name']) {
      parcel.rrr = {
        entries: [
          {
            rrrId: `LRRR-${featureId}`,
            type: RightType.OWN_FREE,
            holder: props['owner'] || props['owner_name'] || '',
            share: 100,
            validFrom: props['registration_date'] || '',
            validTo: '',
            documentRef: props['deed_ref'] || props['document_ref'] || '',
            documents: [],
            restrictions: [],
            responsibilities: [],
          },
        ],
      };
    }

    return parcel;
  }

  private createBuildingFromFeature(featureInfo: SelectedFeatureInfo): BuildingInfo {
    const props = featureInfo.olFeature?.getProperties() || {};
    const geometry = featureInfo.olFeature?.getGeometry();
    const featureId = String(featureInfo.featureId ?? '');

    // Compute spatial properties from geometry
    let footprintArea = 0;
    let geometryType = 'Polygon';

    if (geometry) {
      geometryType = geometry.getType();
      const mapProjection = this.mapService.mapInstance?.getView().getProjection();
      if (geometry instanceof Polygon || geometry instanceof MultiPolygon) {
        footprintArea = getArea(geometry, { projection: mapProjection }) || 0;
      }
    }

    return {
      summary: {
        buildingId: props['building_id'] || props['buildingId'] || props['id'] || featureId,
        legalStatus: this.resolveEnum(props['legal_status'], LegalStatus, LegalStatus.FREEHOLD),
        address: props['building_name'] || props['address'] || props['name'] || '',
        primaryUse: this.resolveEnum(
          props['primary_use'] || props['function'] || props['usage'],
          PrimaryUse,
          PrimaryUse.RES,
        ),
        cadastralRef: props['cadastral_ref'] || props['cadastralRef'] || props['lot_number'] || '',
        floorCount:
          props['floor_count'] ||
          props['floors'] ||
          props['storeys_above_ground'] ||
          props['number_of_floors'] ||
          1,
        registrationDate: props['registration_date'] || props['created_at'] || '',
        postalAddress: props['postal_ad_build'] || props['postal_address'] || '',
        householdNo: props['house_hold_no'] || props['household_no'] || '',
        propertyType: props['bld_property_type'] || props['property_type'] || '',
        accessRoad: props['access_road'] === 'Yes' || props['access_road'] === true,
      },
      spatial: {
        footprint: geometryType,
        solidGeometry: props['solid_geometry'] || 'N/A',
        lodLevel: this.resolveEnum(props['lod_level'], LodLevel, LodLevel.LOD0),
        height: props['height'] || props['measured_height'] || 0,
        crs: this.resolveEnum(props['crs'], CRS, CRS.EPSG_4326),
        elevationRef: this.resolveEnum(props['elevation_ref'], ElevationRef, ElevationRef.GROUND),
      },
      rrr: {
        entries:
          props['owner'] || props['owner_name']
            ? [
                {
                  rrrId: `BRRR-${featureId}`,
                  type: RightType.OWN_FREE,
                  holder: props['owner'] || props['owner_name'] || '',
                  share: 100,
                  validFrom: props['registration_date'] || '',
                  validTo: '',
                  documentRef: props['deed_ref'] || props['document_ref'] || '',
                  documents: [],
                  restrictions: [],
                  responsibilities: [],
                },
              ]
            : [],
      },
      units: [],
      physicalAttributes: {
        constructionYear: props['construction_year'] || props['year_of_construction'] || 0,
        structureType: this.resolveEnum(
          props['structure_type'],
          StructureType,
          StructureType.CONC_REINF,
        ),
        condition: this.resolveEnum(props['condition'], Condition, Condition.GOOD),
        roofType: this.resolveEnum(props['roof_type'], RoofType, RoofType.FLAT),
        wallType: props['wall_type'] || '',
        grossArea: props['gross_area'] || Math.round(footprintArea * 100) / 100,
        extBuildUseType: props['ext_builduse_type'] || '',
        extBuildUseSubType: props['ext_builduse_sub_type'] || '',
      },
      utilities: {
        electricity: '',
        telephone: '',
        internet: '',
        waterDrink: '',
        water: '',
        drainage: '',
        sanitationSewer: '',
        sanitationGully: '',
        garbageDisposal: '',
      },
      taxValuation: {
        assessedValue: props['assessed_value'] || 0,
        marketValue: props['market_value'] || 0,
        annualTax: props['annual_tax'] || 0,
        lastAssessmentDate: props['last_assessment_date'] || '',
        taxStatus: props['tax_status'] || 'pending',
      },
      relationshipsTopology: {
        parcelRelation: this.resolveParcelRelation(props),
        adjacentBuildings: props['adjacent_buildings'] || '',
        sharedWall: props['shared_wall'] ?? false,
        topologyStatus: this.resolveEnum(
          props['topology_status'],
          TopologyStatus,
          TopologyStatus.VALID,
        ),
        overlapVolume: props['overlap_volume'] || 0,
        partOfComplex: props['complex_id'] || '',
      },
      metadataQuality: {
        dataQualityID: props['data_quality_id'] || `DQ-${Date.now()}`,
        accuracyLevel: this.resolveEnum(
          props['accuracy_level'],
          AccuracyLevel,
          AccuracyLevel.ACC_TIER2,
        ),
        surveyMethod: this.resolveEnum(props['survey_method'], SurveyMethod, SurveyMethod.DIGIT_2D),
        lastUpdated: props['updated_at'] || props['last_updated'] || new Date().toISOString(),
        responsibleParty: props['responsible_party'] || props['surveyor'] || '',
        sourceFile: props['source_file'] || '',
      },
    };
  }

  private resolveParcelRelation(props: Record<string, any>): string {
    const raw =
      props['ref_ids'] ??
      props['ref_id'] ??
      props['parcel_relation'] ??
      props['parcel_id'] ??
      props['parent_parcel'] ??
      '';
    if (Array.isArray(raw)) return raw.filter((v) => v != null && v !== '').join(', ');
    return raw == null ? '' : String(raw);
  }

  private resolveEnum<T extends Record<string, string>>(
    raw: string | undefined | null,
    enumObj: T,
    defaultValue: T[keyof T],
  ): T[keyof T] {
    if (!raw || typeof raw !== 'string') return defaultValue;
    const values = Object.values(enumObj);
    if (values.includes(raw as any)) return raw as T[keyof T];
    // Try uppercase match
    const upper = raw.toUpperCase().replace(/[\s-]/g, '_');
    const match = values.find((v) => v === upper);
    if (match) return match as T[keyof T];
    return defaultValue;
  }

  // ─── Land Panel Change Handlers ─────────────────────────
  onLandRRRChanged(rrr: RRRInfo): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, rrr });
  }

  onLandIdentificationChanged(identification: ParcelIdentification): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, identification });
  }

  onLandSpatialChanged(spatial: ParcelSpatial): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, spatial });
  }

  onLandPhysicalChanged(physical: ParcelPhysical): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, physical });
  }

  onLandZoningChanged(zoning: ParcelZoning): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, zoning });
  }

  onLandValuationChanged(valuation: ParcelValuation): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, valuation });
  }

  onLandRelationshipsChanged(relationships: ParcelRelationships): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, relationships });
  }

  onLandMetadataChanged(metadata: ParcelMetadata): void {
    const current = this.currentLandParcelInfo();
    if (!current) return;
    this.currentLandParcelInfo.set({ ...current, metadata });
  }

  private relationshipRowValue(row: any): string {
    const raw = row?.new_value ?? row?.newValue ?? '';
    if (Array.isArray(raw)) return raw.filter((v) => v != null && `${v}`.trim()).join(', ');
    if (raw && typeof raw === 'object') {
      return Object.values(raw)
        .filter((v) => v != null && `${v}`.trim())
        .join(', ');
    }
    return raw == null ? '' : `${raw}`.trim();
  }

  private currentRelationshipValue(rows: any[], fieldNames: string[]): string {
    const match = rows.find(
      (row) => row?.action === 'current' && fieldNames.includes(row?.field_name),
    );
    return this.relationshipRowValue(match);
  }

  private mergeComputedLandRelationships(
    relationships: ParcelRelationships,
    relationshipRows: any[],
  ): void {
    const parent =
      this.currentRelationshipValue(relationshipRows, ['parent_id', 'parent_parcel']) ||
      relationships.parentParcel;
    const children =
      this.currentRelationshipValue(relationshipRows, ['child_ids', 'child_parcels']) ||
      relationships.childParcels;
    const adjacent =
      this.currentRelationshipValue(relationshipRows, ['adjacent_parcels']) ||
      relationships.adjacentParcels;
    const estate =
      this.currentRelationshipValue(relationshipRows, ['part_of_estate']) ||
      relationships.partOfEstate;

    relationships.parentParcel = parent;
    relationships.childParcels = children;
    relationships.adjacentParcels = adjacent;
    relationships.partOfEstate = estate;
  }

  private fetchAndMergeLandParcelData(su_id: string | number): void {
    forkJoin([
      this.apiService.getAdministrativeInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getLandOverViewInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getltAssesAndTaxInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getRRRData(su_id).pipe(catchError(() => of(null))),
      this.apiService.getZoningInfo(su_id).pipe(catchError(() => of(null))),
      this.apiService.getPhysicalEnvInfo(su_id).pipe(catchError(() => of(null))),
      this.apiService.getItInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getLandMetadata(su_id).pipe(catchError(() => of({}))),
      this.apiService.getParcelHistory(su_id).pipe(catchError(() => of({ relationships: [] }))),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ([
          adminData,
          overviewData,
          taxData,
          rrrData,
          zoningData,
          physicalData,
          utilData,
          metaData,
          historyData,
        ]: [any, any, any, any, any, any, any, any, any]) => {
          console.log('[Fetch] adminData from backend:', adminData);
          const current = this.currentLandParcelInfo();
          if (!current) return;

          const identification = { ...current.identification };
          const physical = { ...current.physical };
          const spatial = { ...current.spatial };
          const valuation = { ...current.valuation };

          // Merge admin data
          if (adminData.local_auth) identification.localAuthority = adminData.local_auth;
          if (adminData.sl_land_type)
            identification.parcelType = this.resolveEnum(
              adminData.sl_land_type,
              ParcelType,
              current.identification.parcelType,
            );
          if (adminData.land_name) identification.cadastralRef = adminData.land_name;
          if (adminData.registration_date)
            identification.registrationDate = adminData.registration_date;
          if (adminData.access_road !== undefined)
            physical.accessRoad = adminData.access_road === 'Yes' || adminData.access_road === true;
          if (adminData.parcel_status)
            identification.parcelStatus = this.resolveEnum(
              adminData.parcel_status,
              ParcelStatus,
              current.identification.parcelStatus,
            );
          if (adminData.tenure_type)
            identification.tenureType = this.resolveEnum(
              adminData.tenure_type,
              TenureType,
              current.identification.tenureType,
            );
          // Parcel relationship fields
          const relationships = { ...current.relationships };
          if (adminData.adjacent_parcels != null)
            relationships.adjacentParcels = adminData.adjacent_parcels;
          if (adminData.parent_parcel != null) relationships.parentParcel = adminData.parent_parcel;
          if (adminData.child_parcels != null) relationships.childParcels = adminData.child_parcels;
          if (adminData.part_of_estate != null)
            relationships.partOfEstate = adminData.part_of_estate;
          this.mergeComputedLandRelationships(relationships, historyData?.relationships ?? []);

          // GND-derived read-only administrative hierarchy
          identification.gndName = adminData.gnd ?? identification.gndName;
          identification.dsd = adminData.dsd ?? identification.dsd;
          identification.district = adminData.dist ?? identification.district;
          identification.province = adminData.pd ?? identification.province;
          identification.electoralDiv = adminData.eletorate ?? identification.electoralDiv;

          // Merge land overview data (crs/boundary_type from la_ls_land_unit)
          // NOTE: area and perimeter are always taken from the OL-computed geometry, not the stored value
          if (overviewData.perimeter != null) spatial.perimeter = Number(overviewData.perimeter);
          if (overviewData.boundary_type)
            spatial.boundaryType = this.resolveEnum(
              overviewData.boundary_type,
              BoundaryType,
              current.spatial.boundaryType,
            );
          if (overviewData.crs) spatial.crs = overviewData.crs;
          if (overviewData.dimension_2d_3d) spatial.geometryType = overviewData.dimension_2d_3d;
          if (overviewData.ext_landuse_type)
            identification.landUse = this.resolveEnum(
              overviewData.ext_landuse_type,
              LandUse,
              current.identification.landUse,
            );

          // Merge tax/assessment data
          if (taxData.land_value != null) valuation.landValue = Number(taxData.land_value);
          if (taxData.tax_annual_value != null)
            valuation.annualTax = Number(taxData.tax_annual_value);
          if (taxData.date_of_valuation) valuation.lastAssessmentDate = taxData.date_of_valuation;
          if (taxData.market_value != null) valuation.marketValue = Number(taxData.market_value);
          if (taxData.tax_status) valuation.taxStatus = taxData.tax_status;

          // Merge physical/environmental data
          if (physicalData) {
            if (physicalData.elevation != null) physical.elevation = Number(physicalData.elevation);
            if (physicalData.slope != null) physical.slope = Number(physicalData.slope);
            if (physicalData.soil_type) physical.soilType = physicalData.soil_type as SoilType;
            if (physicalData.flood_zone != null)
              physical.floodZone = Boolean(physicalData.flood_zone);
            if (physicalData.vegetation_cover)
              physical.vegetationCover = physicalData.vegetation_cover;
          }

          // Merge utility network data (LA_LS_Utinet_LU_Model)
          if (utilData) {
            if (utilData.water_supply != null) physical.waterSupply = utilData.water_supply || '';
            if (utilData.electricity != null) physical.electricity = utilData.electricity || '';
            if (utilData.drainage_system != null)
              physical.drainageSystem = utilData.drainage_system || '';
            if (utilData.sanitation_sewer != null)
              physical.sanitationSewer = utilData.sanitation_sewer || '';
            if (utilData.sanitation_gully != null)
              physical.sanitationGully = utilData.sanitation_gully || '';
            if (utilData.garbage_disposal != null)
              physical.garbageDisposal = utilData.garbage_disposal || '';
          }

          // Merge RRR data
          this.fetchedRRRBaUnitIds.clear();
          this.fetchedRRRMap.clear();
          const rrrEntries: RRREntry[] = [];
          const records = rrrData?.records || [];
          for (const record of records) {
            this.fetchedRRRBaUnitIds.add(record.ba_unit_id);
            // Map admin_sources → RRRDocument[] so uploaded docs appear in the panel
            const docs = (record.admin_sources || [])
              .filter((src: any) => !!src.file_url)
              .map((src: any) => {
                return {
                  name: src.admin_source_type || 'Document',
                  type: 'application/octet-stream',
                  size: 0,
                  fileUrl: src.file_url,
                  adminSourceId: src.admin_source_id,
                  docLinkId: src.doc_link_id ?? undefined,
                };
              });
            console.log(`[RRR Merge - Land] ba_unit_id=${record.ba_unit_id} mapped docs:`, docs);
            for (const rrr of record.rrrs || []) {
              const entryId = `BU-${record.ba_unit_id}`;
              if (rrr.rrr_id) this.fetchedRRRMap.set(entryId, rrr.rrr_id);
              const primaryParty = (rrr.parties || [])[0];
              rrrEntries.push({
                rrrId: entryId,
                backendRrrId: rrr.rrr_id,
                type: (rrr.share_type as RightType) || RightType.OWN_FREE,
                holder: primaryParty?.party_name || '',
                holderId: String(primaryParty?.pid || ''),
                holderType: undefined,
                share: primaryParty?.share ?? rrr.share,
                validFrom: rrr.time_begin || '',
                validTo: rrr.time_end || '',
                documentRef: record.sl_ba_unit_name || '',
                documents: docs,
                restrictions: (rrr.restrictions || []).map((r: any) => ({
                  id: r.id,
                  type: r.rrr_restriction_type,
                  description: r.description || '',
                  validFrom: r.time_begin || '',
                  validTo: r.time_end || '',
                })),
                responsibilities: (rrr.responsibilities || []).map((r: any) => ({
                  id: r.id,
                  type: r.rrr_responsibility_type,
                  description: r.description || '',
                  validFrom: r.time_begin || '',
                  validTo: r.time_end || '',
                })),
              });
            }
          }

          // Merge zoning data
          const zoning = { ...current.zoning };
          if (zoningData) {
            if (zoningData.zoning_category)
              zoning.zoningCategory = zoningData.zoning_category as ZoningCategory;
            if (zoningData.max_building_height != null)
              zoning.maxBuildingHeight = Number(zoningData.max_building_height);
            if (zoningData.max_coverage != null)
              zoning.maxCoverage = Number(zoningData.max_coverage);
            if (zoningData.max_far != null) zoning.maxFAR = Number(zoningData.max_far);
            if (zoningData.setback_front != null)
              zoning.setbackFront = Number(zoningData.setback_front);
            if (zoningData.setback_rear != null)
              zoning.setbackRear = Number(zoningData.setback_rear);
            if (zoningData.setback_side != null)
              zoning.setbackSide = Number(zoningData.setback_side);
            if (zoningData.special_overlay) zoning.specialOverlay = zoningData.special_overlay;
          }

          // Merge metadata (la_spatial_source)
          const metadata = { ...current.metadata };
          if (metaData) {
            if (metaData.spatial_source_type)
              metadata.surveyMethod = metaData.spatial_source_type as SurveyMethod;
            if (metaData.source_id) metadata.sourceDocument = metaData.source_id;
            if (metaData.surveyor_name) metadata.responsibleParty = metaData.surveyor_name;
            if (metaData.date_accept) metadata.lastUpdated = metaData.date_accept;
            if (metaData.description)
              metadata.accuracyLevel = metaData.description as AccuracyLevel;
          }

          this.currentLandParcelInfo.set({
            ...current,
            identification,
            physical,
            spatial,
            valuation,
            rrr: { entries: rrrEntries },
            zoning,
            metadata,
            relationships,
          });

          // Second phase: fetch restrictions & responsibilities per BA unit (property level)
          const ba_unit_entries = Array.from(this.fetchedRRRBaUnitIds).map(
            (id) => [`BU-${id}`, id] as [string, number],
          );
          if (ba_unit_entries.length > 0) {
            const restrictionReqs = ba_unit_entries.map(([, bid]) =>
              this.apiService.getRRRRestrictions(bid).pipe(catchError(() => of([]))),
            );
            const responsibilityReqs = ba_unit_entries.map(([, bid]) =>
              this.apiService.getRRRResponsibilities(bid).pipe(catchError(() => of([]))),
            );
            forkJoin([...restrictionReqs, ...responsibilityReqs])
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe((results: any[]) => {
                const half = ba_unit_entries.length;
                const updatedEntries = [...rrrEntries];
                ba_unit_entries.forEach(([entryId], idx) => {
                  const entry = updatedEntries.find((e) => e.rrrId === entryId);
                  if (!entry) return;
                  entry.restrictions = (results[idx] as any[]).map((r: any) => ({
                    id: r.id,
                    type: r.rrr_restriction_type as RestrictionType,
                    description: r.description || '',
                    validFrom: r.time_begin || '',
                    validTo: r.time_end || '',
                  }));
                  entry.responsibilities = (results[half + idx] as any[]).map((r: any) => ({
                    id: r.id,
                    type: r.rrr_responsibility_type as ResponsibilityType,
                    description: r.description || '',
                    validFrom: r.time_begin || '',
                    validTo: r.time_end || '',
                  }));
                });
                const current2 = this.currentLandParcelInfo();
                if (current2) {
                  this.currentLandParcelInfo.set({
                    ...current2,
                    rrr: { entries: updatedEntries },
                  });
                }
              });
          }
        },
      );
  }

  private fetchAndMergeBuildingData(su_id: string | number): void {
    forkJoin([
      this.apiService.getBuildingAdministrativeInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getltAssesAndTaxInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getRRRData(su_id).pipe(catchError(() => of(null))),
      this.apiService.getBuildingOverViewInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getBuildItInfo(su_id).pipe(catchError(() => of({}))),
      this.apiService.getBuildingUnits(su_id).pipe(catchError(() => of({ count: 0, units: [] }))),
      this.apiService.getLandMetadata(su_id).pipe(catchError(() => of({}))),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        ([adminData, taxData, rrrData, overviewData, utilData, unitsData, metaData]: [
          any,
          any,
          any,
          any,
          any,
          any,
          any,
        ]) => {
          const current = this.currentBuildingInfo();
          if (!current) return;

          const summary = { ...current.summary };
          const physicalAttributes = { ...current.physicalAttributes };
          const relationshipsTopology = { ...current.relationshipsTopology };
          const metadataQuality = { ...current.metadataQuality };
          const taxValuation = {
            ...(current.taxValuation ?? {
              assessedValue: 0,
              marketValue: 0,
              annualTax: 0,
              lastAssessmentDate: '',
              taxStatus: 'pending' as const,
            }),
          };

          // Merge admin data
          if (adminData.building_name) summary.address = adminData.building_name;
          if (adminData.registration_date) summary.registrationDate = adminData.registration_date;
          if (adminData.no_floors != null) summary.floorCount = Number(adminData.no_floors);
          if (adminData.postal_ad_build) summary.postalAddress = adminData.postal_ad_build;
          if (adminData.house_hold_no) summary.householdNo = adminData.house_hold_no;
          if (adminData.bld_property_type) summary.propertyType = adminData.bld_property_type;
          if (adminData.access_road !== undefined)
            summary.accessRoad = adminData.access_road === 'Yes' || adminData.access_road === true;
          if (adminData.construction_year != null)
            physicalAttributes.constructionYear = Number(adminData.construction_year);
          if (adminData.structure_type)
            physicalAttributes.structureType = adminData.structure_type as StructureType;
          if (adminData.condition) physicalAttributes.condition = adminData.condition as Condition;
          if (adminData.wall_type) physicalAttributes.wallType = adminData.wall_type;

          // Merge overview data (roof type, gross area, building use type)
          if (overviewData.roof_type)
            physicalAttributes.roofType = overviewData.roof_type as RoofType;
          if (overviewData.area != null) physicalAttributes.grossArea = Number(overviewData.area);
          if (overviewData.ext_builduse_type)
            physicalAttributes.extBuildUseType = overviewData.ext_builduse_type;
          if (overviewData.ext_builduse_sub_type)
            physicalAttributes.extBuildUseSubType = overviewData.ext_builduse_sub_type;

          // Merge tax/assessment data
          if (taxData.assessment_annual_value != null)
            taxValuation.assessedValue = Number(taxData.assessment_annual_value);
          if (taxData.tax_annual_value != null)
            taxValuation.annualTax = Number(taxData.tax_annual_value);
          if (taxData.date_of_valuation)
            taxValuation.lastAssessmentDate = taxData.date_of_valuation;
          if (taxData.market_value != null) taxValuation.marketValue = Number(taxData.market_value);
          if (taxData.tax_status) taxValuation.taxStatus = taxData.tax_status;

          const featureProps = this.selected_featureInfo?.olFeature?.getProperties?.() || {};
          relationshipsTopology.parcelRelation =
            this.resolveParcelRelation(featureProps) || relationshipsTopology.parcelRelation || '';

          if (metaData.source_id) metadataQuality.sourceFile = metaData.source_id;
          if (metaData.description && !metadataQuality.sourceFile)
            metadataQuality.sourceFile = metaData.description;
          if (metaData.surveyor_name) metadataQuality.responsibleParty = metaData.surveyor_name;
          if (metaData.date_accept) metadataQuality.lastUpdated = metaData.date_accept;

          // Merge RRR data
          this.fetchedRRRBaUnitIds.clear();
          this.fetchedRRRMap.clear();
          const rrrEntries: RRREntry[] = [];
          const records = rrrData?.records || [];
          for (const record of records) {
            this.fetchedRRRBaUnitIds.add(record.ba_unit_id);
            // Map admin_sources → RRRDocument[] so uploaded docs appear in the panel
            const docs = (record.admin_sources || [])
              .filter((src: any) => !!src.file_url)
              .map((src: any) => {
                return {
                  name: src.admin_source_type || 'Document',
                  type: 'application/octet-stream',
                  size: 0,
                  fileUrl: src.file_url,
                  adminSourceId: src.admin_source_id,
                  docLinkId: src.doc_link_id ?? undefined,
                };
              });
            for (const rrr of record.rrrs || []) {
              const entryId = `BU-${record.ba_unit_id}`;
              if (rrr.rrr_id) this.fetchedRRRMap.set(entryId, rrr.rrr_id);
              const primaryParty = (rrr.parties || [])[0];
              rrrEntries.push({
                rrrId: entryId,
                backendRrrId: rrr.rrr_id,
                type: (rrr.share_type as RightType) || RightType.OWN_FREE,
                holder: primaryParty?.party_name || '',
                holderId: String(primaryParty?.pid || ''),
                holderType: undefined,
                share: primaryParty?.share ?? rrr.share,
                validFrom: rrr.time_begin || '',
                validTo: rrr.time_end || '',
                documentRef: record.sl_ba_unit_name || '',
                documents: docs,
                restrictions: (rrr.restrictions || []).map((r: any) => ({
                  id: r.id,
                  type: r.rrr_restriction_type,
                  description: r.description || '',
                  validFrom: r.time_begin || '',
                  validTo: r.time_end || '',
                })),
                responsibilities: (rrr.responsibilities || []).map((r: any) => ({
                  id: r.id,
                  type: r.rrr_responsibility_type,
                  description: r.description || '',
                  validFrom: r.time_begin || '',
                  validTo: r.time_end || '',
                })),
              });
            }
          }

          // Merge building utility data (LA_LS_Utinet_BU_Model)
          const utilities: UtilityInfo = {
            electricity: utilData?.elec || '',
            telephone: utilData?.tele || '',
            internet: utilData?.internet || '',
            waterDrink: utilData?.water_drink || '',
            water: utilData?.water || '',
            drainage: utilData?.drainage || '',
            sanitationSewer: utilData?.sani_sewer || '',
            sanitationGully: utilData?.sani_gully || '',
            garbageDisposal: utilData?.garbage_dispose || '',
          };

          // Map DB-backed apartment units → BuildingUnit[]
          const dbUnits: BuildingUnit[] = (unitsData?.units ?? []).map((u: any) => ({
            unitId: String(u.su_id),
            parentBuilding: String(su_id),
            floorNumber: u.floor_no ?? 0,
            unitType: this.mapLegalSpaceTypeToUnitType(u.building_unit_type, u.bld_property_type),
            legalSpaceType: u.building_unit_type ?? 'UNASSIGNED',
            postalAddressRef: u.postal_ad_build ?? '',
            boundary: u.geom_3d_wkt ?? '',
            accessType: AccessType.COR,
            cadastralRef: u.cadastral_id ?? u.apt_name ?? '',
            floorArea: u.floor_area ?? 0,
            registrationDate: u.registration_date ?? '',
            primaryUse: (u.ext_builduse_type as PrimaryUse) ?? PrimaryUse.RES,
            rooms: Array.isArray(u.component_units) ? u.component_units : [],
            cadastralCertificates: [],
            physicalAttributes: {
              constructionYear: u.construction_year ?? 0,
              structureType: (u.structure_type as StructureType) ?? StructureType.CONC_REINF,
              condition: (u.condition as Condition) ?? Condition.GOOD,
              roofType: (u.roof_type as RoofType) ?? RoofType.FLAT,
              wallType: u.wall_type ?? '',
              grossArea: u.floor_area ?? 0,
              extBuildUseType: u.ext_builduse_type ?? '',
              extBuildUseSubType: u.ext_builduse_sub_type ?? '',
            },
            utilities: {
              electricity: u.utility?.elec ?? '',
              telephone: u.utility?.tele ?? '',
              internet: u.utility?.internet ?? '',
              waterDrink: u.utility?.water_drink ?? '',
              water: u.utility?.water ?? '',
              drainage: u.utility?.drainage ?? '',
              sanitationSewer: u.utility?.sani_sewer ?? '',
              sanitationGully: u.utility?.sani_gully ?? '',
              garbageDisposal: u.utility?.garbage_dispose ?? '',
            },
            tax: {
              taxUnitArea: u.floor_area ?? 0,
              assessedValue: 0,
              lastValuationDate: '',
              taxDue: 0,
            },
            rrr: { entries: [] },
          }));

          this.currentBuildingInfo.set({
            ...current,
            summary,
            physicalAttributes,
            taxValuation,
            utilities,
            relationshipsTopology,
            metadataQuality,
            rrr: { entries: rrrEntries },
            units: dbUnits.length > 0 ? dbUnits : current.units,
          });

          if (dbUnits.length > 0) {
            forkJoin(
              dbUnits.map((unit) =>
                this.apiService.getRRRData(unit.unitId).pipe(catchError(() => of({ records: [] }))),
              ),
            )
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe((unitRrrResponses: any[]) => {
                const current3 = this.currentBuildingInfo();
                if (!current3) return;
                const unitsWithRrr = current3.units.map((unit, index) => ({
                  ...unit,
                  rrr: { entries: this.mapRrrDataToEntries(unitRrrResponses[index]) },
                }));
                this.currentBuildingInfo.set({ ...current3, units: unitsWithRrr });
              });
          }

          // Second phase: fetch restrictions & responsibilities per BA unit (property level)
          const ba_unit_entries_bld = Array.from(this.fetchedRRRBaUnitIds).map(
            (id) => [`BU-${id}`, id] as [string, number],
          );
          if (ba_unit_entries_bld.length > 0) {
            const restrictionReqs = ba_unit_entries_bld.map(([, bid]) =>
              this.apiService.getRRRRestrictions(bid).pipe(catchError(() => of([]))),
            );
            const responsibilityReqs = ba_unit_entries_bld.map(([, bid]) =>
              this.apiService.getRRRResponsibilities(bid).pipe(catchError(() => of([]))),
            );
            forkJoin([...restrictionReqs, ...responsibilityReqs])
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe((results: any[]) => {
                const half = ba_unit_entries_bld.length;
                const updatedEntries = [...rrrEntries];
                ba_unit_entries_bld.forEach(([entryId], idx) => {
                  const entry = updatedEntries.find((e) => e.rrrId === entryId);
                  if (!entry) return;
                  entry.restrictions = (results[idx] as any[]).map((r: any) => ({
                    id: r.id,
                    type: r.rrr_restriction_type as RestrictionType,
                    description: r.description || '',
                    validFrom: r.time_begin || '',
                    validTo: r.time_end || '',
                  }));
                  entry.responsibilities = (results[half + idx] as any[]).map((r: any) => ({
                    id: r.id,
                    type: r.rrr_responsibility_type as ResponsibilityType,
                    description: r.description || '',
                    validFrom: r.time_begin || '',
                    validTo: r.time_end || '',
                  }));
                });
                const current2 = this.currentBuildingInfo();
                if (current2) {
                  this.currentBuildingInfo.set({
                    ...current2,
                    rrr: { entries: updatedEntries },
                  });
                }
              });
          }
        },
      );
  }

  onSaveBuildingInfo(info: BuildingInfo): void {
    const su_id = this.selected_feature_ID;
    if (this.isSavingBuilding()) {
      return;
    }
    if (!su_id) {
      this.notificationService.showError('No building selected. Please select a building first.');
      return;
    }
    this.isSavingBuilding.set(true);
    this.notificationService.showInfo?.('Saving building information...');

    const bldPayload = {
      building_name: info.summary.address,
      no_floors: info.summary.floorCount,
      registration_date: info.summary.registrationDate || null,
      postal_ad_build: info.summary.postalAddress,
      house_hold_no: info.summary.householdNo,
      bld_property_type: info.summary.propertyType,
      access_road: info.summary.accessRoad ? 'Yes' : 'No',
      construction_year: info.physicalAttributes.constructionYear || null,
      structure_type: info.physicalAttributes.structureType,
      condition: info.physicalAttributes.condition,
      wall_type: info.physicalAttributes.wallType,
    };

    const taxPayload = {
      assessment_annual_value: info.taxValuation?.assessedValue,
      tax_annual_value: info.taxValuation?.annualTax,
      date_of_valuation: info.taxValuation?.lastAssessmentDate,
      market_value: info.taxValuation?.marketValue,
      tax_status: info.taxValuation?.taxStatus,
    };

    const metadataPayload = {
      source_id: info.metadataQuality.sourceFile || null,
      description: info.metadataQuality.sourceFile || null,
      surveyor_name: info.metadataQuality.responsibleParty || null,
      date_accept: info.metadataQuality.lastUpdated?.split('T')[0] || null,
    };

    const overviewPayload = {
      roof_type: info.physicalAttributes.roofType || null,
      area: info.physicalAttributes.grossArea || null,
      ext_builduse_type: info.physicalAttributes.extBuildUseType || null,
      ext_builduse_sub_type: info.physicalAttributes.extBuildUseSubType || null,
    };

    forkJoin([
      this.apiService.updateBuildingAdministrativeInfo(su_id, bldPayload, 'building'),
      this.apiService.updateTaxAndAssessmentInfo(su_id, taxPayload, 'building'),
      this.apiService.updateBuildOverviewInfo(su_id, overviewPayload, 'building'),
      this.apiService.updateLandMetadata(su_id, metadataPayload),
      this.apiService
        .updateSurveyRepData(su_id, {
          ref_id: this.numericRelationId(info.relationshipsTopology.parcelRelation),
        })
        .pipe(catchError(() => of(null))),
    ])
      .pipe(
        finalize(() => this.isSavingBuilding.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notificationService.showSuccess('Building details saved successfully.');
        },
        error: (err) => {
          console.error('Save building error:', err);
          console.error('Backend response:', err.error);
          this.notificationService.showError('Failed to save building details. Please try again.');
        },
      });

    // Building utility save: fire-and-forget
    if (info.utilities) {
      const bldUtilPayload = {
        elec: info.utilities.electricity,
        tele: info.utilities.telephone,
        internet: info.utilities.internet,
        water_drink: info.utilities.waterDrink,
        water: info.utilities.water,
        drainage: info.utilities.drainage,
        sani_sewer: info.utilities.sanitationSewer,
        sani_gully: info.utilities.sanitationGully,
        garbage_dispose: info.utilities.garbageDisposal,
      };
      this.apiService
        .updateBuildingITUtilInfo(su_id, bldUtilPayload, 'building')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }

    this.saveBuildingUnits(info, Number(su_id));
  }

  private saveBuildingUnits(info: BuildingInfo, parentSuId: number): void {
    for (const unit of info.units) {
      const payload = {
        parent_su_id: parentSuId,
        apt_name: unit.cadastralRef || unit.unitId,
        floor_no: unit.floorNumber,
        floor_area: unit.floorArea,
        building_unit_type: unit.legalSpaceType || 'UNASSIGNED',
        cadastral_id: unit.cadastralRef || null,
        component_units: unit.rooms || [],
        postal_ad_build: unit.postalAddressRef || null,
        bld_property_type: unit.unitType,
        registration_date: unit.registrationDate || null,
        ext_builduse_type: unit.primaryUse,
        ext_builduse_sub_type: unit.physicalAttributes?.extBuildUseSubType || null,
        construction_year: unit.physicalAttributes?.constructionYear || null,
        structure_type: unit.physicalAttributes?.structureType || null,
        condition: unit.physicalAttributes?.condition || null,
        roof_type: unit.physicalAttributes?.roofType || null,
        wall_type: unit.physicalAttributes?.wallType || null,
        utility: {
          elec: unit.utilities?.electricity || null,
          tele: unit.utilities?.telephone || null,
          internet: unit.utilities?.internet || null,
          water_drink: unit.utilities?.waterDrink || null,
          water: unit.utilities?.water || null,
          drainage: unit.utilities?.drainage || null,
          sani_sewer: unit.utilities?.sanitationSewer || null,
          sani_gully: unit.utilities?.sanitationGully || null,
          garbage_dispose: unit.utilities?.garbageDisposal || null,
        },
      };
      const isExistingUnit = /^\d+$/.test(String(unit.unitId));
      const saveUnit$ = isExistingUnit
        ? this.apiService.updateBuildingUnit(unit.unitId, payload)
        : this.apiService.createBuildingUnit(payload);

      saveUnit$
        .pipe(
          switchMap((res: any) => {
            const unitSuId = isExistingUnit ? Number(unit.unitId) : Number(res?.su_id);
            if (!unitSuId) return of(null);
            if (!isExistingUnit) {
              this.promoteLocalBuildingUnitId(String(unit.unitId), unitSuId);
            }
            const taxPayload: Record<string, any> = {};
            if (unit.tax?.assessedValue) {
              taxPayload['assessment_annual_value'] = unit.tax.assessedValue;
              taxPayload['market_value'] = unit.tax.assessedValue;
            }
            if (unit.tax?.taxDue) taxPayload['tax_annual_value'] = unit.tax.taxDue;
            if (unit.tax?.lastValuationDate)
              taxPayload['date_of_valuation'] = unit.tax.lastValuationDate;

            const taxSave$ = Object.keys(taxPayload).length
              ? this.apiService
                  .updateTaxAndAssessmentInfo(unitSuId, taxPayload, 'building-unit')
                  .pipe(catchError(() => of(null)))
              : of(null);

            return taxSave$.pipe(
              switchMap(() => {
                this.saveUnitCertificates(unit, unitSuId);
                return of(null);
              }),
            );
          }),
          catchError((e) => {
            console.error('[Save] Building unit save error:', e);
            return of(null);
          }),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe();
    }
  }

  private mapLegalSpaceTypeToUnitType(
    legalSpaceType: string | null | undefined,
    fallback: string | null | undefined,
  ): UnitType {
    switch (legalSpaceType) {
      case 'COMMERCIAL':
        return UnitType.OFF;
      case 'CIRCULATION':
      case 'AMENITY':
        return UnitType.COM;
      case 'SERVICE':
      case 'PARKING':
        return UnitType.UTL;
      case 'RESIDENTIAL':
        return UnitType.APT;
      default:
        return (fallback as UnitType) || UnitType.APT;
    }
  }

  private numericRelationId(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    const first = String(value).split(',')[0].trim();
    if (!first) return null;
    const parsed = Number(first);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private promoteLocalBuildingUnitId(localUnitId: string, backendSuId: number): void {
    this.currentBuildingInfo.update((curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        units: curr.units.map((unit) =>
          unit.unitId === localUnitId
            ? {
                ...unit,
                unitId: String(backendSuId),
                parentBuilding: String(this.selected_feature_ID || unit.parentBuilding),
              }
            : unit,
        ),
      };
    });
  }

  private saveUnitCertificates(unit: BuildingUnit, unitSuId: number): void {
    const files = (unit.cadastralCertificates || []).filter((doc) => doc.file);
    for (const doc of files) {
      const fd = new FormData();
      fd.append('su_id', String(unitSuId));
      fd.append('spatial_source_type', 'Cadastral Certificate');
      fd.append('source_id', unit.cadastralRef || `Unit ${unit.unitId}`);
      fd.append('description', doc.name || 'Apartment cadastral certificate');
      fd.append('file_path', doc.file as File);
      this.apiService
        .postSpatialSource(fd)
        .pipe(
          catchError((e) => {
            console.error('[Save] Unit certificate upload error:', e);
            this.notificationService.showError('Failed to upload unit cadastral certificate.');
            return of(null);
          }),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe();
    }
  }

  private saveUnitRRREntries(unit: BuildingUnit, unitSuId: number): void {
    for (const entry of unit.rrr.entries) {
      if (!entry.holderId) continue;
      if (entry.rrrId.startsWith('BU-')) {
        const baUnitId = Number(entry.rrrId.replace('BU-', ''));
        if (!baUnitId) continue;
        this.apiService
          .patchRRREntry(baUnitId, {
            sl_ba_unit_name: entry.holder,
            sl_ba_unit_type: 'OWNERSHIP',
            admin_source_type: entry.documentRef || 'Title Deed',
            time_begin: entry.validFrom || null,
            time_end: entry.validTo || null,
            share: entry.share,
            share_type: entry.type,
            party_role_type: entry.type,
            rrr_type: entry.type,
          })
          .pipe(
            catchError((e) => {
              console.error('[Save] Unit RRR update error:', e);
              this.notificationService.showError('Failed to update building unit RRR information.');
              return of(null);
            }),
            takeUntilDestroyed(this.destroyRef),
          )
          .subscribe(() => this.syncRRRSubRecords(baUnitId, entry));
        this.uploadRRRDocuments(baUnitId, entry, 'unit');
        continue;
      }

      const fd = new FormData();
      fd.append('su_id', String(unitSuId));
      fd.append('code', entry.holder);
      fd.append('la_ba_unit_type', 'basicPropertyUnit');
      fd.append('admin_source_type', entry.documentRef || 'Title Deed');
      const localFiles = (entry.documents || []).filter((d) => d.file);
      if (localFiles.length > 0) fd.append('file', localFiles[0].file as File);
      fd.append(
        'rights',
        JSON.stringify([
          {
            party: entry.holderId,
            share_type: entry.type,
            share: entry.share,
            right_type: entry.type,
            date_start: entry.validFrom || null,
            date_end: entry.validTo || null,
            description: '',
          },
        ]),
      );
      this.apiService
        .postAdminSource(fd)
        .pipe(
          switchMap((res: any) => {
            const rrrId = res?.created_rrr_ids?.[0];
            const baUnitId = res?.ba_unit_id;
            if (baUnitId) this.syncRRRSubRecords(baUnitId, entry);
            if (baUnitId && localFiles.length > 1) {
              this.uploadRRRDocuments(baUnitId, entry, 'unit', 1);
            }
            if (baUnitId) {
              this.promoteLocalUnitRRRId(unitSuId, entry.rrrId, baUnitId, rrrId);
            }
            return of(null);
          }),
          catchError((e) => {
            console.error('[Save] Unit RRR create error:', e);
            this.notificationService.showError('Failed to save building unit RRR information.');
            return of(null);
          }),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe();
    }
  }

  private uploadRRRDocuments(
    baUnitId: number,
    entry: RRREntry,
    scope: 'building' | 'unit' | 'land' = 'building',
    startIndex = 0,
  ): void {
    const files = (entry.documents || []).filter((doc) => doc.file).slice(startIndex);
    for (const doc of files) {
      const fd = new FormData();
      fd.append('file', doc.file as File);
      fd.append('admin_source_type', doc.name || 'Document');
      this.apiService
        .postRRRDocument(baUnitId, fd)
        .pipe(
          catchError((e) => {
            console.error(`[Save] ${scope} RRR document upload error:`, e);
            this.notificationService.showError('Failed to upload RRR document.');
            return of(null);
          }),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe();
    }
  }

  private promoteLocalUnitRRRId(
    unitSuId: number,
    localRrrId: string,
    baUnitId: number,
    backendRrrId?: number,
    fallbackEntry?: RRREntry,
  ): void {
    this.currentBuildingInfo.update((curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        units: curr.units.map((unit) => {
          if (Number(unit.unitId) !== unitSuId) return unit;
          return {
            ...unit,
            rrr: {
              ...unit.rrr,
              entries: unit.rrr.entries.some((entry) => entry.rrrId === localRrrId)
                ? unit.rrr.entries.map((entry) =>
                    entry.rrrId === localRrrId
                      ? { ...entry, rrrId: `BU-${baUnitId}`, backendRrrId }
                      : entry,
                  )
                : fallbackEntry
                  ? [
                      ...unit.rrr.entries,
                      { ...fallbackEntry, rrrId: `BU-${baUnitId}`, backendRrrId },
                    ]
                  : unit.rrr.entries,
            },
          };
        }),
      };
    });
  }

  private mapRrrDataToEntries(rrrData: any): RRREntry[] {
    const entries: RRREntry[] = [];
    const records = rrrData?.records || [];
    for (const record of records) {
      const docs = (record.admin_sources || [])
        .filter((src: any) => !!src.file_url)
        .map((src: any) => ({
          name: src.admin_source_type || 'Document',
          type: 'application/octet-stream',
          size: 0,
          fileUrl: src.file_url,
          adminSourceId: src.admin_source_id,
          docLinkId: src.doc_link_id ?? undefined,
        }));
      for (const rrr of record.rrrs || []) {
        const primaryParty = (rrr.parties || [])[0];
        entries.push({
          rrrId: `BU-${record.ba_unit_id}`,
          backendRrrId: rrr.rrr_id,
          type: (rrr.share_type as RightType) || RightType.OWN_FREE,
          holder: primaryParty?.party_name || '',
          holderId: String(primaryParty?.pid || ''),
          holderType: undefined,
          share: primaryParty?.share ?? rrr.share,
          validFrom: rrr.time_begin || '',
          validTo: rrr.time_end || '',
          documentRef: record.sl_ba_unit_name || '',
          documents: docs,
          restrictions: (rrr.restrictions || []).map((r: any) => ({
            id: r.id,
            type: r.rrr_restriction_type,
            description: r.description || '',
            validFrom: r.time_begin || '',
            validTo: r.time_end || '',
          })),
          responsibilities: (rrr.responsibilities || []).map((r: any) => ({
            id: r.id,
            type: r.rrr_responsibility_type,
            description: r.description || '',
            validFrom: r.time_begin || '',
            validTo: r.time_end || '',
          })),
        });
      }
    }
    return entries;
  }

  onNewParcelRequested(parcel: LandParcelInfo): void {
    // User clicked "+ New Parcel" from the empty state panel.
    // Switch to the land tab with a blank parcel so the form is visible,
    // and activate the draw tool so the user can draw the geometry.
    this.currentLandParcelInfo.set(parcel);
    this.activeSidebarTab.set('land');
    this.drawService.setActiveTool({ type: 'draw', drawType: 'Polygon' });
    this.cdr.markForCheck();
  }

  onSaveLandParcel(info: LandParcelSaveRequest): void {
    const su_id = this.selected_feature_ID;
    if (this.isSavingLandParcel()) {
      return;
    }
    if (!su_id) {
      this.notificationService.showError('No parcel selected. Please select a parcel first.');
      return;
    }

    const dirtyFields = new Set(info.__dirtyFields ?? []);
    if (!dirtyFields.size) {
      this.notificationService.showInfo?.('No parcel detail changes to save.');
      return;
    }

    const changed = (path: string) => dirtyFields.has(path);
    const hasPayload = (payload: Record<string, any>) => Object.keys(payload).length > 0;
    const scopedRequests = [];

    const scopedAdminPayload: Record<string, any> = {};
    if (changed('identification.parcelType'))
      scopedAdminPayload['sl_land_type'] = info.identification.parcelType;
    if (changed('identification.tenureType'))
      scopedAdminPayload['tenure_type'] = info.identification.tenureType;
    if (changed('identification.cadastralRef'))
      scopedAdminPayload['land_name'] = info.identification.cadastralRef;
    if (changed('physical.accessRoad'))
      scopedAdminPayload['access_road'] = info.physical.accessRoad ? 'Yes' : 'No';
    if (changed('identification.registrationDate'))
      scopedAdminPayload['registration_date'] = info.identification.registrationDate || null;
    if (changed('identification.parcelStatus'))
      scopedAdminPayload['parcel_status'] = info.identification.parcelStatus;
    if (changed('relationships.adjacentParcels'))
      scopedAdminPayload['adjacent_parcels'] = info.relationships.adjacentParcels || null;
    if (changed('relationships.parentParcel'))
      scopedAdminPayload['parent_parcel'] = info.relationships.parentParcel || null;
    if (changed('relationships.childParcels'))
      scopedAdminPayload['child_parcels'] = info.relationships.childParcels || null;
    if (changed('relationships.partOfEstate'))
      scopedAdminPayload['part_of_estate'] = info.relationships.partOfEstate || null;
    if (hasPayload(scopedAdminPayload)) {
      scopedRequests.push(
        this.apiService.updateAdministrativeInfo(su_id, scopedAdminPayload, 'land').pipe(
          catchError((e) => {
            console.error('[Save] admin info error:', e);
            return of(null);
          }),
        ),
      );
    }

    const scopedOverviewPayload: Record<string, any> = {};
    if (changed('spatial.area')) scopedOverviewPayload['area'] = info.spatial.area;
    if (changed('spatial.perimeter')) scopedOverviewPayload['perimeter'] = info.spatial.perimeter;
    if (changed('identification.landUse'))
      scopedOverviewPayload['ext_landuse_type'] = info.identification.landUse;
    if (changed('spatial.centroidLon') || changed('spatial.centroidLat'))
      scopedOverviewPayload['reference_coordinate'] =
        `${info.spatial.centroidLon},${info.spatial.centroidLat}`;
    if (changed('spatial.geometryType'))
      scopedOverviewPayload['dimension_2d_3d'] = info.spatial.geometryType?.includes('3')
        ? '3D'
        : '2D';
    if (changed('spatial.boundaryType'))
      scopedOverviewPayload['boundary_type'] = info.spatial.boundaryType;
    if (changed('spatial.crs')) scopedOverviewPayload['crs'] = info.spatial.crs;
    if (hasPayload(scopedOverviewPayload)) {
      scopedRequests.push(
        this.apiService.updateLandOverviewInfo(su_id, scopedOverviewPayload, 'land').pipe(
          catchError((e) => {
            console.error('[Save] overview error:', e);
            return of(null);
          }),
        ),
      );
    }

    const scopedTaxPayload: Record<string, any> = {};
    if (changed('valuation.landValue')) scopedTaxPayload['land_value'] = info.valuation.landValue;
    if (changed('valuation.annualTax'))
      scopedTaxPayload['tax_annual_value'] = info.valuation.annualTax;
    if (changed('valuation.lastAssessmentDate'))
      scopedTaxPayload['date_of_valuation'] = info.valuation.lastAssessmentDate;
    if (changed('valuation.marketValue'))
      scopedTaxPayload['market_value'] = info.valuation.marketValue;
    if (changed('valuation.taxStatus')) scopedTaxPayload['tax_status'] = info.valuation.taxStatus;
    if (hasPayload(scopedTaxPayload)) {
      scopedRequests.push(
        this.apiService.updateTaxAndAssessmentInfo(su_id, scopedTaxPayload, 'land').pipe(
          catchError((e) => {
            console.error('[Save] tax error:', e);
            return of(null);
          }),
        ),
      );
    }

    const scopedPhysicalEnvPayload: Record<string, any> = {};
    if (changed('physical.elevation'))
      scopedPhysicalEnvPayload['elevation'] = info.physical.elevation;
    if (changed('physical.slope')) scopedPhysicalEnvPayload['slope'] = info.physical.slope;
    if (changed('physical.soilType'))
      scopedPhysicalEnvPayload['soil_type'] = info.physical.soilType;
    if (changed('physical.floodZone'))
      scopedPhysicalEnvPayload['flood_zone'] = info.physical.floodZone;
    if (changed('physical.vegetationCover'))
      scopedPhysicalEnvPayload['vegetation_cover'] = info.physical.vegetationCover;
    if (hasPayload(scopedPhysicalEnvPayload)) {
      scopedRequests.push(
        this.apiService.updatePhysicalEnvInfo(su_id, scopedPhysicalEnvPayload).pipe(
          catchError((e) => {
            console.error('[Save] physical error:', e);
            return of(null);
          }),
        ),
      );
    }

    const scopedZoningPayload: Record<string, any> = {};
    if (changed('zoning.zoningCategory'))
      scopedZoningPayload['zoning_category'] = info.zoning.zoningCategory;
    if (changed('zoning.maxBuildingHeight'))
      scopedZoningPayload['max_building_height'] = info.zoning.maxBuildingHeight;
    if (changed('zoning.maxCoverage'))
      scopedZoningPayload['max_coverage'] = info.zoning.maxCoverage;
    if (changed('zoning.maxFAR')) scopedZoningPayload['max_far'] = info.zoning.maxFAR;
    if (changed('zoning.setbackFront'))
      scopedZoningPayload['setback_front'] = info.zoning.setbackFront;
    if (changed('zoning.setbackRear'))
      scopedZoningPayload['setback_rear'] = info.zoning.setbackRear;
    if (changed('zoning.setbackSide'))
      scopedZoningPayload['setback_side'] = info.zoning.setbackSide;
    if (changed('zoning.specialOverlay'))
      scopedZoningPayload['special_overlay'] = info.zoning.specialOverlay;
    if (hasPayload(scopedZoningPayload)) {
      scopedRequests.push(
        this.apiService.updateZoningInfo(su_id, scopedZoningPayload).pipe(
          catchError((e) => {
            console.error('[Save] zoning error:', e);
            return of(null);
          }),
        ),
      );
    }

    const scopedUtilPayload: Record<string, any> = {};
    if (changed('physical.waterSupply'))
      scopedUtilPayload['water_supply'] = info.physical.waterSupply;
    if (changed('physical.electricity'))
      scopedUtilPayload['electricity'] = info.physical.electricity;
    if (changed('physical.drainageSystem'))
      scopedUtilPayload['drainage_system'] = info.physical.drainageSystem;
    if (changed('physical.sanitationSewer'))
      scopedUtilPayload['sanitation_sewer'] = info.physical.sanitationSewer;
    if (changed('physical.sanitationGully'))
      scopedUtilPayload['sanitation_gully'] = info.physical.sanitationGully;
    if (changed('physical.garbageDisposal'))
      scopedUtilPayload['garbage_disposal'] = info.physical.garbageDisposal;
    if (hasPayload(scopedUtilPayload)) {
      scopedRequests.push(
        this.apiService.updateITUtilInfo(su_id, scopedUtilPayload, 'land').pipe(
          catchError((e) => {
            console.error('[Save] utility error:', e);
            return of(null);
          }),
        ),
      );
    }

    const scopedMetadataPayload: Record<string, any> = {};
    if (changed('metadata.surveyMethod'))
      scopedMetadataPayload['spatial_source_type'] = info.metadata.surveyMethod;
    if (changed('metadata.sourceDocument'))
      scopedMetadataPayload['source_id'] = info.metadata.sourceDocument;
    if (changed('metadata.accuracyLevel'))
      scopedMetadataPayload['description'] = info.metadata.accuracyLevel;
    if (changed('metadata.lastUpdated'))
      scopedMetadataPayload['date_accept'] = info.metadata.lastUpdated?.split('T')[0] || null;
    if (changed('metadata.responsibleParty'))
      scopedMetadataPayload['surveyor_name'] = info.metadata.responsibleParty;
    if (hasPayload(scopedMetadataPayload)) {
      scopedRequests.push(
        this.apiService.updateLandMetadata(su_id, scopedMetadataPayload).pipe(
          catchError((e) => {
            console.error('[Save] metadata error:', e);
            return of(null);
          }),
        ),
      );
    }

    if (!scopedRequests.length) {
      this.notificationService.showInfo?.('No backend-saveable parcel detail changes found.');
      return;
    }

    this.isSavingLandParcel.set(true);
    this.notificationService.showInfo?.('Saving parcel details...');
    forkJoin(scopedRequests)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .pipe(finalize(() => this.isSavingLandParcel.set(false)))
      .subscribe({
        next: () => {
          this.notificationService.showSuccess('Parcel details saved successfully.');
        },
        error: (err) => {
          console.error('Save parcel error:', err);
          console.error('Backend response:', err.error);
          this.notificationService.showError('Failed to save parcel details. Please try again.');
        },
      });
    return;

    this.isSavingLandParcel.set(true);
    this.notificationService.showInfo?.('Saving parcel details...');

    // access_road is a CharField on the backend — must be a string, not boolean
    const adminPayload = {
      local_auth: info.identification.localAuthority,
      sl_land_type: info.identification.parcelType,
      tenure_type: info.identification.tenureType,
      land_name: info.identification.cadastralRef,
      access_road: info.physical.accessRoad ? 'Yes' : 'No',
      registration_date: info.identification.registrationDate || null,
      parcel_status: info.identification.parcelStatus,
      adjacent_parcels: info.relationships.adjacentParcels || null,
      parent_parcel: info.relationships.parentParcel || null,
      child_parcels: info.relationships.childParcels || null,
      part_of_estate: info.relationships.partOfEstate || null,
    };

    const overviewPayload = {
      area: info.spatial.area,
      perimeter: info.spatial.perimeter,
      ext_landuse_type: info.identification.landUse,
      reference_coordinate: `${info.spatial.centroidLon},${info.spatial.centroidLat}`,
      dimension_2d_3d: info.spatial.geometryType?.includes('3') ? '3D' : '2D',
      boundary_type: info.spatial.boundaryType,
      crs: info.spatial.crs,
    };

    const taxPayload = {
      land_value: info.valuation.landValue,
      tax_annual_value: info.valuation.annualTax,
      date_of_valuation: info.valuation.lastAssessmentDate,
      market_value: info.valuation.marketValue,
      tax_status: info.valuation.taxStatus,
    };

    const physicalEnvPayload = {
      elevation: info.physical.elevation,
      slope: info.physical.slope,
      soil_type: info.physical.soilType,
      flood_zone: info.physical.floodZone,
      vegetation_cover: info.physical.vegetationCover,
    };

    const zoningPayload = {
      zoning_category: info.zoning.zoningCategory,
      max_building_height: info.zoning.maxBuildingHeight,
      max_coverage: info.zoning.maxCoverage,
      max_far: info.zoning.maxFAR,
      setback_front: info.zoning.setbackFront,
      setback_rear: info.zoning.setbackRear,
      setback_side: info.zoning.setbackSide,
      special_overlay: info.zoning.specialOverlay,
    };

    forkJoin([
      this.apiService.updateAdministrativeInfo(su_id, adminPayload, 'land').pipe(
        catchError((e) => {
          console.error('[Save] admin info error:', e);
          return of(null);
        }),
      ),
      this.apiService.updateLandOverviewInfo(su_id, overviewPayload, 'land').pipe(
        catchError((e) => {
          console.error('[Save] overview error:', e);
          return of(null);
        }),
      ),
      this.apiService.updateTaxAndAssessmentInfo(su_id, taxPayload, 'land').pipe(
        catchError((e) => {
          console.error('[Save] tax error:', e);
          return of(null);
        }),
      ),
      this.apiService.updateZoningInfo(su_id, zoningPayload).pipe(
        catchError((e) => {
          console.error('[Save] zoning error:', e);
          return of(null);
        }),
      ),
      this.apiService.updatePhysicalEnvInfo(su_id, physicalEnvPayload).pipe(
        catchError((e) => {
          console.error('[Save] physical error:', e);
          return of(null);
        }),
      ),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .pipe(finalize(() => this.isSavingLandParcel.set(false)))
      .subscribe({
        next: () => {
          this.notificationService.showSuccess('Parcel details saved successfully.');
        },
        error: (err) => {
          console.error('Save parcel error:', err);
          // Log the backend's validation error detail for easier debugging
          console.error('Backend response:', err.error);
          this.notificationService.showError('Failed to save parcel details. Please try again.');
        },
      });

    // Utility network save: fire-and-forget
    const utilPayload = {
      water_supply: info.physical.waterSupply,
      electricity: info.physical.electricity,
      drainage_system: info.physical.drainageSystem,
      sanitation_sewer: info.physical.sanitationSewer,
      sanitation_gully: info.physical.sanitationGully,
      garbage_disposal: info.physical.garbageDisposal,
    };
    this.apiService
      .updateITUtilInfo(su_id, utilPayload, 'land')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();

    // Metadata save: fire-and-forget (la_spatial_source)
    const metadataPayload = {
      spatial_source_type: info.metadata.surveyMethod,
      source_id: info.metadata.sourceDocument,
      description: info.metadata.accuracyLevel,
      date_accept: info.metadata.lastUpdated?.split('T')[0] || null,
      surveyor_name: info.metadata.responsibleParty,
    };
    this.apiService
      .updateLandMetadata(su_id, metadataPayload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  // ─── RRR Sub-record Sync Helper ────────────────────────
  // Diff-based sync: only deletes removed records and only creates new ones.
  // Records that already have an `id` (fetched from backend) and are still
  // present in the local list are left untouched.
  /**
   * After a newly-added RRR entry is successfully saved on the backend,
   * rewrite its local rrrId from `LRRR-<ts>` / `BRRR-<ts>` to `BU-<ba_unit_id>`
   * so that:
   *   - A subsequent save() does NOT re-POST it through the "new entries"
   *     filter and create a duplicate row.
   *   - It looks identical to any entry fetched fresh from the backend,
   *     keeping the rendered list consistent (no ghost "double" entries).
   * Also tracks the new ba_unit_id so the delete-orphans loop doesn't
   * mistakenly remove it on the next save.
   */
  private promoteLocalRRRId(
    localRrrId: string,
    baUnitId: number,
    target: 'land' | 'building',
    backendRrrId?: number,
  ): void {
    const newRrrId = `BU-${baUnitId}`;
    this.fetchedRRRBaUnitIds.add(baUnitId);
    if (backendRrrId) this.fetchedRRRMap.set(newRrrId, backendRrrId);

    if (target === 'land') {
      this.currentLandParcelInfo.update((curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          rrr: {
            ...curr.rrr,
            entries: curr.rrr.entries.map((e) =>
              e.rrrId === localRrrId ? { ...e, rrrId: newRrrId, backendRrrId } : e,
            ),
          },
        };
      });
    } else {
      this.currentBuildingInfo.update((curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          rrr: {
            ...curr.rrr,
            entries: curr.rrr.entries.map((e) =>
              e.rrrId === localRrrId ? { ...e, rrrId: newRrrId, backendRrrId } : e,
            ),
          },
        };
      });
    }
  }

  private terminateRemovedRRREntry(baUnitId: number): void {
    const entryId = `BU-${baUnitId}`;
    const rrrId = this.fetchedRRRMap.get(entryId);
    const request$ = rrrId
      ? this.apiService.terminateRRR(rrrId)
      : this.apiService.deleteRrr(String(baUnitId));

    request$
      .pipe(
        catchError((e) => {
          console.error('[Save] RRR delete/terminate error:', e);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private syncRRRSubRecords(ba_unit_id: number, entry: RRREntry): void {
    const localRestrictionIds = new Set(
      entry.restrictions.map((r) => r.id).filter((id) => id != null),
    );
    const localResponsibilityIds = new Set(
      entry.responsibilities.map((r) => r.id).filter((id) => id != null),
    );

    this.apiService
      .getRRRRestrictions(ba_unit_id)
      .pipe(
        switchMap((existing: any) => {
          const toDelete = (existing as any[]).filter((r: any) => !localRestrictionIds.has(r.id));
          const delObs = toDelete.map((r: any) =>
            this.apiService.deleteRRRRestriction(ba_unit_id, r.id).pipe(catchError(() => of(null))),
          );
          return delObs.length > 0 ? forkJoin(delObs) : of([]);
        }),
        switchMap(() => {
          const toCreate = entry.restrictions.filter((r) => r.id == null);
          const createObs = toCreate.map((r) =>
            this.apiService
              .postRRRRestriction(ba_unit_id, {
                rrr_restriction_type: r.type,
                description: r.description,
                time_begin: r.validFrom || null,
                time_end: r.validTo || null,
              })
              .pipe(catchError(() => of(null))),
          );
          return createObs.length > 0 ? forkJoin(createObs) : of([]);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();

    this.apiService
      .getRRRResponsibilities(ba_unit_id)
      .pipe(
        switchMap((existing: any) => {
          const toDelete = (existing as any[]).filter(
            (r: any) => !localResponsibilityIds.has(r.id),
          );
          const delObs = toDelete.map((r: any) =>
            this.apiService
              .deleteRRRResponsibility(ba_unit_id, r.id)
              .pipe(catchError(() => of(null))),
          );
          return delObs.length > 0 ? forkJoin(delObs) : of([]);
        }),
        switchMap(() => {
          const toCreate = entry.responsibilities.filter((r) => r.id == null);
          const createObs = toCreate.map((r) =>
            this.apiService
              .postRRRResponsibility(ba_unit_id, {
                rrr_responsibility_type: r.type,
                description: r.description,
                time_begin: r.validFrom || null,
                time_end: r.validTo || null,
              })
              .pipe(catchError(() => of(null))),
          );
          return createObs.length > 0 ? forkJoin(createObs) : of([]);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  // ─── Building Panel Change Handlers ────────────────────
  onBuildingRRRChanged(rrr: RRRInfo): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, rrr });
  }

  onBuildingSummaryChanged(summary: BuildingSummary): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, summary });
  }

  onBuildingUnitsChanged(units: BuildingUnit[]): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, units });
  }

  onBuildingCompositionChanged(): void {
    if (!this.selected_feature_ID) return;
    this.fetchAndMergeBuildingData(this.selected_feature_ID);
  }

  onBuildingSpatialChanged(spatial: SpatialInfo): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, spatial });
  }

  onBuildingPhysicalChanged(physicalAttributes: PhysicalAttributes): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, physicalAttributes });
  }

  onBuildingUtilitiesChanged(utilities: UtilityInfo): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, utilities });
  }

  onBuildingTaxValuationChanged(taxValuation: TaxValuation): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, taxValuation });
  }

  onBuildingRelationshipsChanged(relationshipsTopology: RelationshipsTopology): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, relationshipsTopology });
  }

  onBuildingMetadataChanged(metadataQuality: MetadataQuality): void {
    const current = this.currentBuildingInfo();
    if (!current) return;
    this.currentBuildingInfo.set({ ...current, metadataQuality });
  }

  handleRRRCreate(event: { suId: number | string; entry: RRREntry; unitIndex?: number }): void {
    const { suId, entry, unitIndex } = event;
    if (unitIndex !== undefined && !Number.isFinite(Number(suId))) {
      this.notificationService.showError(
        'Please save the building unit before adding RRR details.',
      );
      return;
    }
    const localRrrId = entry.rrrId;
    const localFiles = (entry.documents || []).filter((d) => d.file);

    this.notificationService.showInfo?.('Creating RRR entry...');

    const fd = new FormData();
    fd.append('su_id', String(suId));
    fd.append('code', entry.holder);
    fd.append('la_ba_unit_type', 'basicPropertyUnit');
    fd.append('admin_source_type', entry.documentRef || 'Title Deed');
    if (localFiles.length > 0) fd.append('file', localFiles[0].file as File);
    fd.append(
      'rights',
      JSON.stringify([
        {
          party: entry.holderId,
          share_type: entry.type,
          share: entry.share,
          right_type: entry.type,
          date_start: entry.validFrom || null,
          date_end: entry.validTo || null,
          description: '',
        },
      ]),
    );

    this.apiService
      .postAdminSource(fd)
      .pipe(
        switchMap((res: any) => {
          const rrr_id = res?.created_rrr_ids?.[0];
          const ba_unit_id = res?.ba_unit_id;
          if (ba_unit_id) this.syncRRRSubRecords(ba_unit_id, entry);

          if (ba_unit_id) {
            if (unitIndex !== undefined) {
              this.promoteLocalUnitRRRId(Number(suId), localRrrId, ba_unit_id, rrr_id, entry);
            } else {
              const target = this.activeSidebarTab() === 'building' ? 'building' : 'land';
              this.promoteLocalRRRId(localRrrId, ba_unit_id, target, rrr_id);
            }
          }

          if (ba_unit_id && localFiles.length > 1) {
            for (const doc of localFiles.slice(1)) {
              const extraFd = new FormData();
              extraFd.append('file', doc.file as File);
              extraFd.append('admin_source_type', doc.name || 'Document');
              this.apiService
                .postRRRDocument(ba_unit_id, extraFd)
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe();
            }
          }
          return of(null);
        }),
        catchError((e) => {
          console.error('[Central Save] RRR create error:', e);
          this.notificationService.showError('Failed to create RRR entry.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.notificationService.showSuccess('RRR entry created successfully.');
        if (this.activeSidebarTab() === 'building') {
          this.fetchAndMergeBuildingData(this.selected_feature_ID);
        } else {
          this.fetchAndMergeLandParcelData(this.selected_feature_ID);
        }
      });
  }

  handleRRRUpdate(event: { baUnitId: number; entry: RRREntry; unitIndex?: number }): void {
    const { baUnitId, entry, unitIndex } = event;
    const target = this.activeSidebarTab() === 'building' ? 'building' : 'land';

    this.notificationService.showInfo?.('Saving RRR details...');

    const updatePayload = {
      sl_ba_unit_name: entry.holder,
      sl_ba_unit_type: 'OWNERSHIP',
      admin_source_type: entry.documentRef || 'Title Deed',
      time_begin: entry.validFrom || null,
      time_end: entry.validTo || null,
      share: entry.share,
      share_type: entry.type,
      party_role_type: entry.type,
      rrr_type: entry.type,
    };

    forkJoin([
      this.apiService.patchRRREntry(baUnitId, updatePayload),
      of(this.syncRRRSubRecords(baUnitId, entry)),
    ])
      .pipe(
        catchError((e) => {
          console.error('[Central Save] RRR update error:', e);
          this.notificationService.showError('Failed to update RRR entry.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notificationService.showSuccess('RRR details saved.');
          if (target === 'building') {
            this.fetchAndMergeBuildingData(this.selected_feature_ID);
          } else {
            this.fetchAndMergeLandParcelData(this.selected_feature_ID);
          }
        },
      });
  }

  handleRRRDelete(event: { baUnitId: number; unitIndex?: number }): void {
    const { baUnitId, unitIndex } = event;
    const entryId = `BU-${baUnitId}`;
    const rrrId = this.fetchedRRRMap.get(entryId);
    const target = this.activeSidebarTab() === 'building' ? 'building' : 'land';

    this.notificationService.showInfo?.('Terminating RRR entry...');

    const request$ = rrrId
      ? this.apiService.terminateRRR(rrrId)
      : this.apiService.deleteRrr(String(baUnitId));

    request$
      .pipe(
        catchError((e) => {
          console.error('[Central Save] RRR terminate error:', e);
          this.notificationService.showError('Failed to terminate RRR entry.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.notificationService.showSuccess('RRR entry terminated successfully.');
        if (target === 'building') {
          this.fetchAndMergeBuildingData(this.selected_feature_ID);
        } else {
          this.fetchAndMergeLandParcelData(this.selected_feature_ID);
        }
      });
  }

  handleRRRDocumentUpload(event: {
    baUnitId: number;
    file: File;
    name: string;
    entryIndex: number;
    unitIndex?: number;
  }): void {
    const { baUnitId, file, name, entryIndex, unitIndex } = event;
    const target = this.activeSidebarTab() === 'building' ? 'building' : 'land';

    this.notificationService.showInfo?.(`Uploading ${name}...`);

    const fd = new FormData();
    fd.append('file', file as File);
    fd.append('admin_source_type', name || 'Document');

    this.apiService
      .postRRRDocument(baUnitId, fd)
      .pipe(
        catchError((e) => {
          console.error('[Central Save] RRR document upload error:', e);
          this.notificationService.showError('Failed to upload document.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.notificationService.showSuccess('Document uploaded.');
        if (target === 'building') {
          this.fetchAndMergeBuildingData(this.selected_feature_ID);
        } else {
          this.fetchAndMergeLandParcelData(this.selected_feature_ID);
        }
      });
  }

  handleRRRDocumentDelete(event: {
    docLinkId: number;
    entryIndex: number;
    docIndex: number;
    unitIndex?: number;
  }): void {
    const { docLinkId, entryIndex, docIndex, unitIndex } = event;
    const target = this.activeSidebarTab() === 'building' ? 'building' : 'land';

    this.notificationService.showInfo?.('Removing document...');

    this.apiService
      .deleteRRRDocument(docLinkId)
      .pipe(
        catchError((e) => {
          console.error('[Central Save] RRR document delete error:', e);
          this.notificationService.showError('Failed to remove document.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.notificationService.showSuccess('Document removed.');
        if (target === 'building') {
          this.fetchAndMergeBuildingData(this.selected_feature_ID);
        } else {
          this.fetchAndMergeLandParcelData(this.selected_feature_ID);
        }
      });
  }

  openGenerateReport(): void {
    const tab = this.activeSidebarTab();
    const data: GenerateReportData = {
      type: tab === 'building' ? 'building' : 'land',
      parcel: this.currentLandParcelInfo(),
      building: this.currentBuildingInfo(),
      featureId: this.selected_feature_ID,
      layerId: this.selected_layer_ID ?? null,
    };
    this.dialog.open(GenerateReportComponent, {
      data,
      width: '480px',
      panelClass: 'gr-launcher-panel',
    });
  }
}
