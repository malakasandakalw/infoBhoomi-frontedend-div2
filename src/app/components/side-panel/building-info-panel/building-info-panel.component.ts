import {
  Component,
  inject,
  input,
  output,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy,
} from '@angular/core';
import { BuildingSectionPermissions } from '../../../core/constant';

import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { APIsService } from '../../../services/api.service';
import {
  BuildingInfo,
  BuildingSummary,
  BuildingUnit,
  UnitTaxValuation,
  TaxValuation,
  RRREntry,
  RRRInfo,
  RRRDocument,
  RRRRestriction,
  RRRResponsibility,
  SpatialInfo,
  PhysicalAttributes,
  UtilityInfo,
  RelationshipsTopology,
  MetadataQuality,
  LegalStatus,
  PrimaryUse,
  RightType,
  RestrictionType,
  ResponsibilityType,
  UnitType,
  AccessType,
  LodLevel,
  ElevationRef,
  CRS,
  StructureType,
  Condition,
  RoofType,
  TopologyStatus,
  AccuracyLevel,
  SurveyMethod,
  PartyType,
  LEGAL_STATUS_DISPLAY,
  PRIMARY_USE_DISPLAY,
  RIGHT_TYPE_DISPLAY,
  RESTRICTION_TYPE_DISPLAY,
  RESPONSIBILITY_TYPE_DISPLAY,
  UNIT_TYPE_DISPLAY,
  ACCESS_TYPE_DISPLAY,
  LOD_LEVEL_DISPLAY,
  ELEVATION_REF_DISPLAY,
  CRS_DISPLAY,
  STRUCTURE_TYPE_DISPLAY,
  CONDITION_DISPLAY,
  ROOF_TYPE_DISPLAY,
  TOPOLOGY_STATUS_DISPLAY,
  ACCURACY_LEVEL_DISPLAY,
  SURVEY_METHOD_DISPLAY,
  PARTY_TYPE_DISPLAY,
} from '../../../models/building-info.model';
import { UnitCompositionComponent } from '../../dialogs/unit-composition/unit-composition.component';
import {
  AddRightHolderComponent,
  AddRightHolderResult,
} from '../../dialogs/add-right-holder/add-right-holder.component';

type RRRTab = 'overview' | 'ownership';
type CollapsibleSection =
  | 'summary'
  | 'spatial'
  | 'rrr'
  | 'units'
  | 'physical'
  | 'utilities'
  | 'relationships'
  | 'metadata'
  | 'tax';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-building-info-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './building-info-panel.component.html',
  styleUrls: ['./building-info-panel.component.css'],
})
export class BuildingInfoPanelComponent {
  // Inputs
  buildingInfo = input<BuildingInfo | null>(null);
  sectionPerms = input<Record<number, any>>({});
  saving = input<boolean>(false);

  // Permission helpers
  readonly BLDG_PERMS = BuildingSectionPermissions;

  canView(permId: number): boolean {
    const p = this.sectionPerms();
    if (!p || Object.keys(p).length === 0) return true;
    const perm = p[permId];
    return !perm || perm.can_view !== false;
  }

  canEdit(permId: number): boolean {
    const p = this.sectionPerms();
    if (!p || Object.keys(p).length === 0) return true;
    const perm = p[permId];
    return !perm || perm.can_edit !== false;
  }

  canAdd(permId: number): boolean {
    const p = this.sectionPerms();
    if (!p || Object.keys(p).length === 0) return true;
    const perm = p[permId];
    return !perm || perm.can_add !== false;
  }
  selectedUnitId = input<string | null>(null);
  modelLoaded = input<boolean>(false);
  availableRooms = input<string[]>([]);
  assignedRoomMap = input<Record<string, string>>({});
  pendingRoomSelection = input<string[]>([]);

  // Outputs
  unitSelected = output<string>();
  explodeViewRequested = output<void>();
  summaryChanged = output<BuildingSummary>();
  rrrChanged = output<RRRInfo>();
  unitsChanged = output<BuildingUnit[]>();
  spatialChanged = output<SpatialInfo>();
  physicalChanged = output<PhysicalAttributes>();
  utilitiesChanged = output<UtilityInfo>();
  taxValuationChanged = output<TaxValuation>();
  relationshipsChanged = output<RelationshipsTopology>();
  metadataChanged = output<MetadataQuality>();
  saveModelRequested = output<void>();
  saveBuildingRequested = output<BuildingInfo>();
  deleteBuildingRequested = output<void>();
  compositionChanged = output<void>();
  startRoomSelection = output<{ unitIndex: number; existingRooms: string[] }>();
  finishRoomSelection = output<{ unitIndex: number; rooms: string[] }>();
  cancelRoomSelection = output<void>();
  highlightRooms = output<string[]>();
  rrrCreateRequested = output<{ suId: number | string; entry: RRREntry; unitIndex?: number }>();
  rrrUpdateRequested = output<{ baUnitId: number; entry: RRREntry; unitIndex?: number }>();
  rrrDeleteRequested = output<{ baUnitId: number; unitIndex?: number }>();
  rrrDocumentUploadRequested = output<{
    baUnitId: number;
    file: File;
    name: string;
    entryIndex: number;
    unitIndex?: number;
  }>();
  rrrDocumentDeleteRequested = output<{
    docLinkId: number;
    entryIndex: number;
    docIndex: number;
    unitIndex?: number;
  }>();

  // Enum option lists
  readonly legalStatusOptions = Object.values(LegalStatus);
  readonly primaryUseOptions = Object.values(PrimaryUse);
  readonly rightTypeOptions = Object.values(RightType);
  readonly restrictionTypeOptions = Object.values(RestrictionType);
  readonly responsibilityTypeOptions = Object.values(ResponsibilityType);
  readonly unitTypeOptions = Object.values(UnitType);
  readonly accessTypeOptions = Object.values(AccessType);
  readonly elevationRefOptions = Object.values(ElevationRef);
  readonly structureTypeOptions = Object.values(StructureType);
  readonly conditionOptions = Object.values(Condition);
  readonly roofTypeOptions = Object.values(RoofType);
  readonly accuracyLevelOptions = Object.values(AccuracyLevel);
  readonly surveyMethodOptions = Object.values(SurveyMethod);
  readonly propertyTypeOptions = [
    'Residential',
    'Commercial',
    'Mixed Use',
    'Industrial',
    'Institutional',
    'Government',
    'Religious',
    'Educational',
    'Health',
    'Other',
  ];
  readonly taxStatusOptions: TaxValuation['taxStatus'][] = ['pending', 'paid', 'overdue'];
  readonly utilityStatusOptions = ['Available', 'Not Available', 'Shared', 'Individual', 'Unknown'];
  readonly wallTypeOptions = [
    'Brick',
    'Concrete',
    'Block',
    'Timber',
    'Steel',
    'Glass',
    'Mixed',
    'Other',
  ];
  readonly legalSpaceTypeOptions = [
    'UNASSIGNED',
    'RESIDENTIAL',
    'COMMERCIAL',
    'CIRCULATION',
    'SERVICE',
    'PARKING',
    'AMENITY',
  ];
  readonly legalSpaceTypeDisplayMap: Record<string, string> = {
    UNASSIGNED: 'Unassigned',
    RESIDENTIAL: 'Private apartment',
    COMMERCIAL: 'Private commercial',
    CIRCULATION: 'Common circulation',
    SERVICE: 'Common service',
    PARKING: 'Common parking',
    AMENITY: 'Common amenity',
  };

  readonly legalStatusDisplayMap = LEGAL_STATUS_DISPLAY;
  readonly primaryUseDisplayMap = PRIMARY_USE_DISPLAY;
  readonly rightTypeDisplayMap = RIGHT_TYPE_DISPLAY;
  readonly restrictionTypeDisplayMap = RESTRICTION_TYPE_DISPLAY;
  readonly responsibilityTypeDisplayMap = RESPONSIBILITY_TYPE_DISPLAY;
  readonly unitTypeDisplayMap = UNIT_TYPE_DISPLAY;
  readonly accessTypeDisplayMap = ACCESS_TYPE_DISPLAY;
  readonly lodLevelDisplayMap = LOD_LEVEL_DISPLAY;
  readonly elevationRefDisplayMap = ELEVATION_REF_DISPLAY;
  readonly crsDisplayMap = CRS_DISPLAY;
  readonly structureTypeDisplayMap = STRUCTURE_TYPE_DISPLAY;
  readonly conditionDisplayMap = CONDITION_DISPLAY;
  readonly roofTypeDisplayMap = ROOF_TYPE_DISPLAY;
  readonly topologyStatusDisplayMap = TOPOLOGY_STATUS_DISPLAY;
  readonly accuracyLevelDisplayMap = ACCURACY_LEVEL_DISPLAY;
  readonly surveyMethodDisplayMap = SURVEY_METHOD_DISPLAY;
  readonly partyTypeDisplayMap = PARTY_TYPE_DISPLAY;

  private dialog = inject(MatDialog);
  private apiService = inject(APIsService);

  // Local RRR state (avoids parent round-trip delay)
  rrrEntries = signal<RRREntry[]>([]);

  // Local state
  expandedSections = signal<Set<CollapsibleSection>>(new Set(['summary', 'units']));
  activeRRRTab = signal<RRRTab>('ownership');
  selectedUnit = signal<BuildingUnit | null>(null);
  expandedRRRId = signal<string | null>(null);
  expandedUnitId = signal<string | null>(null);
  expandedUnitRRRId = signal<string | null>(null);

  editMode = signal(false);
  selectingRoomsForUnit = signal<number | null>(null);

  hasBuilding = computed(() => this.buildingInfo() !== null);

  /**
   * Units / Strata panel shows ONLY composed apartments / common-property LSBUs
   * (those with a real legalSpaceType), not the raw imported rooms. Raw rooms
   * (legalSpaceType UNASSIGNED / empty) are managed in the Unit Composition
   * window, not listed here.
   */
  displayUnits = computed(() => {
    const info = this.buildingInfo();
    if (!info?.units) return [];
    return info.units.filter((u) => {
      const t = (u.legalSpaceType || '').toUpperCase();
      return t && t !== 'UNASSIGNED' && t !== 'ABSORBED';
    });
  });

  /** Count of raw unassigned rooms still to be composed (for a hint label). */
  unassignedRoomCount = computed(() => {
    const info = this.buildingInfo();
    if (!info?.units) return 0;
    return info.units.filter((u) => {
      const t = (u.legalSpaceType || '').toUpperCase();
      return !t || t === 'UNASSIGNED';
    }).length;
  });

  panelState = computed<'empty' | 'save-prompt' | 'details'>(() => {
    if (this.editMode() || this.buildingInfo() !== null) return 'details';
    if (this.modelLoaded()) return 'save-prompt';
    return 'empty';
  });

  unassignedRooms = computed(() => {
    const all = this.availableRooms();
    const map = this.assignedRoomMap();
    const selectingUnit = this.selectingRoomsForUnit();
    const info = this.buildingInfo();
    if (!info || selectingUnit === null) return all;
    const currentUnitId = info.units[selectingUnit]?.unitId;
    return all.filter((roomId) => {
      const assignedTo = map[roomId];
      return !assignedTo || assignedTo === currentUnitId;
    });
  });

  constructor() {
    effect(() => {
      const info = this.buildingInfo();
      const loaded = this.modelLoaded();
      if (info && loaded && !this.editMode()) {
        this.editMode.set(true);
      }
      if (!loaded) {
        this.editMode.set(false);
      }
    });
    // Sync local RRR entries from the input signal whenever it changes
    effect(() => {
      const info = this.buildingInfo();
      this.rrrEntries.set(info ? [...info.rrr.entries] : []);
    });
  }

  /** Update local RRR state immediately and notify parent */
  private updateRRR(entries: RRREntry[]): void {
    this.rrrEntries.set(entries);
    this.rrrChanged.emit({ entries });
  }

  toggleSection(section: CollapsibleSection): void {
    const current = this.expandedSections();
    const newSet = new Set(current);
    if (newSet.has(section)) {
      newSet.delete(section);
    } else {
      newSet.add(section);
    }
    this.expandedSections.set(newSet);
  }

  isSectionExpanded(section: CollapsibleSection): boolean {
    return this.expandedSections().has(section);
  }

  setRRRTab(tab: RRRTab): void {
    this.activeRRRTab.set(tab);
  }

  selectUnit(unit: BuildingUnit): void {
    this.selectedUnit.set(unit);
    this.unitSelected.emit(unit.unitId);
  }

  onExplodeView(): void {
    this.explodeViewRequested.emit();
  }

  formatNumber(value: number | undefined): string {
    if (value === undefined || value === null) return 'N/A';
    return value.toLocaleString();
  }

  formatArea(value: number | undefined): string {
    if (value === undefined || value === null || value === 0) return 'N/A';
    const sqm = value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const acres = (value * 0.000247105).toFixed(4);
    return `${sqm} m²  |  ${acres} acres`;
  }

  formatVolume(value: number | undefined): string {
    if (value === undefined || value === null || value === 0) return 'N/A';
    return `${value.toLocaleString()} m³`;
  }

  formatHeight(value: number | undefined): string {
    if (value === undefined || value === null || value === 0) return 'N/A';
    return `${value.toLocaleString()} m`;
  }

  formatCurrency(value: number | undefined): string {
    if (value === undefined || value === null || value === 0) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  }

  getStatusClass(status: string): string {
    switch (status) {
      case 'occupied':
        return 'status-occupied';
      case 'vacant':
        return 'status-vacant';
      case 'under_construction':
        return 'status-construction';
      default:
        return '';
    }
  }

  getLegalStatusDisplay(code: LegalStatus | undefined): string {
    if (!code) return 'N/A';
    return LEGAL_STATUS_DISPLAY[code] || code;
  }

  getPrimaryUseDisplay(code: PrimaryUse | undefined): string {
    if (!code) return 'N/A';
    return PRIMARY_USE_DISPLAY[code] || code;
  }

  // ─── Summary field editing ────────────────────────────────

  onSummaryFieldChange(field: keyof BuildingSummary, value: string | number): void {
    const info = this.buildingInfo();
    if (!info) return;
    const updated: BuildingSummary = { ...info.summary, [field]: value };
    this.summaryChanged.emit(updated);
  }

  // ─── RRR editing ──────────────────────────────────────────

  toggleRRRExpand(rrrId: string): void {
    this.expandedRRRId.set(this.expandedRRRId() === rrrId ? null : rrrId);
  }

  private cloneEntries(): RRREntry[] {
    return this.rrrEntries().map((e) => ({
      ...e,
      documents: [...(e.documents || []).map((d) => ({ ...d }))],
      restrictions: [...e.restrictions.map((r) => ({ ...r }))],
      responsibilities: [...e.responsibilities.map((r) => ({ ...r }))],
    }));
  }

  onRRRFieldChange(index: number, field: keyof RRREntry, value: any): void {
    const entries = this.rrrEntries().map((e, i) => (i === index ? { ...e, [field]: value } : e));
    this.updateRRR(entries);

    const entry = entries[index];
    if (entry && entry.rrrId.startsWith('BU-') && field === 'type') {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      this.rrrUpdateRequested.emit({ baUnitId, entry });
    }
  }

  onRRRFieldBlur(index: number, field: string): void {
    const entry = this.rrrEntries()[index];
    if (entry && entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      this.rrrUpdateRequested.emit({ baUnitId, entry });
    }
  }

  addRRREntry(): void {
    const dialogRef = this.dialog.open(AddRightHolderComponent, {
      width: '680px',
      maxWidth: '90vw',
      data: { context: 'building' },
      autoFocus: false,
      panelClass: 'arh-dark-dialog',
    });

    dialogRef.afterClosed().subscribe((result: AddRightHolderResult | null) => {
      if (!result) return;
      const newRrrId = `RRR-${Date.now().toString(36).toUpperCase()}`;
      const newEntry: RRREntry = {
        rrrId: newRrrId,
        type: RightType.OWN_FREE,
        holder: result.partyFullName || result.partyName,
        holderId: result.partyId,
        holderType: result.partyType,
        holderRegType: result.regType,
        holderRegNumber: result.regNumber,
        share: 0,
        validFrom: new Date().toISOString().split('T')[0],
        validTo: '',
        documentRef: '',
        documents: [],
        restrictions: [],
        responsibilities: [],
      };
      this.rrrCreateRequested.emit({
        suId: this.buildingInfo()?.summary?.buildingId || 0,
        entry: newEntry,
      });
    });
  }

  confirmRemoveRRREntry(index: number): void {
    const entry = this.rrrEntries()[index];
    if (!entry) return;

    if (entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      if (
        confirm('Are you sure you want to terminate this RRR entry? This action cannot be undone.')
      ) {
        this.rrrDeleteRequested.emit({ baUnitId });
      }
    } else {
      if (confirm('Are you sure you want to delete this unsaved RRR entry?')) {
        const entries = this.rrrEntries().filter((_, i) => i !== index);
        this.updateRRR(entries);
      }
    }
  }

  removeRRREntry(index: number): void {
    const entries = this.rrrEntries().filter((_, i) => i !== index);
    this.updateRRR(entries);
  }

  getAllRestrictions(): {
    entryIndex: number;
    restrictionIndex: number;
    holder: string;
    restriction: RRRRestriction;
  }[] {
    const result: {
      entryIndex: number;
      restrictionIndex: number;
      holder: string;
      restriction: RRRRestriction;
    }[] = [];
    this.rrrEntries().forEach((entry, ei) => {
      entry.restrictions.forEach((r, ri) => {
        result.push({ entryIndex: ei, restrictionIndex: ri, holder: entry.holder, restriction: r });
      });
    });
    return result;
  }

  addStandaloneRestriction(): void {
    const entries = this.cloneEntries();
    if (entries.length === 0) return;
    entries[0].restrictions.push({
      type: RestrictionType.RES_EAS,
      description: '',
      validFrom: '',
      validTo: '',
    });
    this.updateRRR(entries);
  }

  getAllResponsibilities(): {
    entryIndex: number;
    responsibilityIndex: number;
    holder: string;
    responsibility: RRRResponsibility;
  }[] {
    const result: {
      entryIndex: number;
      responsibilityIndex: number;
      holder: string;
      responsibility: RRRResponsibility;
    }[] = [];
    this.rrrEntries().forEach((entry, ei) => {
      entry.responsibilities.forEach((r, ri) => {
        result.push({
          entryIndex: ei,
          responsibilityIndex: ri,
          holder: entry.holder,
          responsibility: r,
        });
      });
    });
    return result;
  }

  addStandaloneResponsibility(): void {
    const entries = this.cloneEntries();
    if (entries.length === 0) return;
    entries[0].responsibilities.push({
      type: ResponsibilityType.RSP_MAINT,
      description: '',
      validFrom: '',
      validTo: '',
    });
    this.updateRRR(entries);
  }

  addRestriction(entryIndex: number): void {
    const entries = this.cloneEntries();
    if (!entries[entryIndex]) return;
    entries[entryIndex].restrictions.push({
      type: RestrictionType.RES_EAS,
      description: '',
      validFrom: '',
      validTo: '',
    });
    this.updateRRR(entries);
  }

  removeRestriction(entryIndex: number, restrictionIndex: number): void {
    const entries = this.cloneEntries();
    if (!entries[entryIndex]) return;
    entries[entryIndex].restrictions.splice(restrictionIndex, 1);
    this.updateRRR(entries);
  }

  onRestrictionChange(
    entryIndex: number,
    restrictionIndex: number,
    field: keyof RRRRestriction,
    value: any,
  ): void {
    const entries = this.cloneEntries();
    if (!entries[entryIndex]?.restrictions[restrictionIndex]) return;
    (entries[entryIndex].restrictions[restrictionIndex] as any)[field] = value;
    this.updateRRR(entries);
  }

  addResponsibility(entryIndex: number): void {
    const entries = this.cloneEntries();
    if (!entries[entryIndex]) return;
    entries[entryIndex].responsibilities.push({
      type: ResponsibilityType.RSP_MAINT,
      description: '',
      validFrom: '',
      validTo: '',
    });
    this.updateRRR(entries);
  }

  removeResponsibility(entryIndex: number, responsibilityIndex: number): void {
    const entries = this.cloneEntries();
    if (!entries[entryIndex]) return;
    entries[entryIndex].responsibilities.splice(responsibilityIndex, 1);
    this.updateRRR(entries);
  }

  onResponsibilityChange(
    entryIndex: number,
    responsibilityIndex: number,
    field: keyof RRRResponsibility,
    value: any,
  ): void {
    const entries = this.cloneEntries();
    if (!entries[entryIndex]?.responsibilities[responsibilityIndex]) return;
    (entries[entryIndex].responsibilities[responsibilityIndex] as any)[field] = value;
    this.updateRRR(entries);
  }

  // ─── Document uploads ───────────────────────────────────────

  onDocumentUpload(entryIndex: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const entry = this.rrrEntries()[entryIndex];
    if (!entry) return;

    const files = Array.from(input.files);
    if (entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      for (const file of files) {
        this.rrrDocumentUploadRequested.emit({
          baUnitId,
          file,
          name: file.name,
          entryIndex,
        });
      }
    } else {
      const docs = [...(entry.documents || [])];
      for (const f of files) {
        docs.push({ name: f.name, type: f.type, size: f.size, file: f });
      }
      const entries = this.rrrEntries().map((e, i) =>
        i === entryIndex ? { ...e, documents: docs } : e,
      );
      this.updateRRR(entries);
    }
    input.value = '';
  }

  removeDocument(entryIndex: number, docIndex: number): void {
    const entry = this.rrrEntries()[entryIndex];
    const doc = entry?.documents?.[docIndex];
    if (!entry || !doc) return;

    if (doc.docLinkId) {
      this.rrrDocumentDeleteRequested.emit({
        docLinkId: doc.docLinkId,
        entryIndex,
        docIndex,
      });
    } else {
      const entries = this.rrrEntries().map((e, i) => {
        if (i !== entryIndex) return e;
        return { ...e, documents: (e.documents || []).filter((_, di) => di !== docIndex) };
      });
      this.updateRRR(entries);
    }
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ─── Unit Editing ──────────────────────────────────────────

  toggleUnitExpand(unitId: string): void {
    this.expandedUnitId.set(this.expandedUnitId() === unitId ? null : unitId);
    this.expandedUnitRRRId.set(null);
  }

  toggleUnitRRRExpand(rrrId: string): void {
    this.expandedUnitRRRId.set(this.expandedUnitRRRId() === rrrId ? null : rrrId);
  }

  private cloneUnits(): BuildingUnit[] {
    const info = this.buildingInfo();
    if (!info) return [];
    return info.units.map((u) => ({
      ...u,
      rooms: [...u.rooms],
      physicalAttributes: u.physicalAttributes ? { ...u.physicalAttributes } : undefined,
      utilities: u.utilities ? { ...u.utilities } : undefined,
      cadastralCertificates: [...(u.cadastralCertificates || []).map((d) => ({ ...d }))],
      tax: { ...u.tax },
      rrr: {
        entries: u.rrr.entries.map((e) => ({
          ...e,
          restrictions: e.restrictions.map((r) => ({ ...r })),
          responsibilities: e.responsibilities.map((r) => ({ ...r })),
        })),
      },
    }));
  }

  private emitUnitsUpdate(units: BuildingUnit[]): void {
    this.unitsChanged.emit(units);
  }

  onUnitFieldChange(unitIndex: number, field: string, value: any): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    (units[unitIndex] as any)[field] = value;
    this.emitUnitsUpdate(units);
  }

  onUnitTaxFieldChange(unitIndex: number, field: keyof UnitTaxValuation, value: any): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    (units[unitIndex].tax as any)[field] = value;
    this.emitUnitsUpdate(units);
  }

  onUnitPhysicalFieldChange(unitIndex: number, field: keyof PhysicalAttributes, value: any): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    const current = units[unitIndex].physicalAttributes ?? {
      constructionYear: 0,
      structureType: StructureType.CONC_REINF,
      condition: Condition.GOOD,
      roofType: RoofType.FLAT,
      wallType: '',
      grossArea: 0,
      extBuildUseType: '',
      extBuildUseSubType: '',
    };
    units[unitIndex].physicalAttributes = { ...current, [field]: value };
    this.emitUnitsUpdate(units);
  }

  onUnitUtilityFieldChange(unitIndex: number, field: keyof UtilityInfo, value: any): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    const current = units[unitIndex].utilities ?? {
      electricity: '',
      telephone: '',
      internet: '',
      waterDrink: '',
      water: '',
      drainage: '',
      sanitationSewer: '',
      sanitationGully: '',
      garbageDisposal: '',
    };
    units[unitIndex].utilities = { ...current, [field]: value };
    this.emitUnitsUpdate(units);
  }

  addUnit(): void {
    const units = this.cloneUnits();
    const parentId = this.buildingInfo()?.summary?.buildingId || '';
    units.push({
      unitId: `U-${Date.now().toString(36).toUpperCase()}`,
      parentBuilding: parentId,
      floorNumber: 0,
      unitType: UnitType.APT,
      legalSpaceType: 'UNASSIGNED',
      postalAddressRef: '',
      boundary: 'Solid',
      accessType: AccessType.COR,
      cadastralRef: '',
      floorArea: 0,
      registrationDate: new Date().toISOString().split('T')[0],
      primaryUse: PrimaryUse.RES,
      rooms: [],
      physicalAttributes: {
        constructionYear: 0,
        structureType: StructureType.CONC_REINF,
        condition: Condition.GOOD,
        roofType: RoofType.FLAT,
        wallType: '',
        grossArea: 0,
        extBuildUseType: '',
        extBuildUseSubType: '',
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
      cadastralCertificates: [],
      tax: { taxUnitArea: 0, assessedValue: 0, lastValuationDate: '', taxDue: 0 },
      rrr: { entries: [] },
    });
    this.emitUnitsUpdate(units);
  }

  removeUnit(unitIndex: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    units.splice(unitIndex, 1);
    this.emitUnitsUpdate(units);
  }

  onUnitCertificateUpload(unitIndex: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    if (!units[unitIndex].cadastralCertificates) units[unitIndex].cadastralCertificates = [];
    for (let i = 0; i < input.files.length; i++) {
      const file = input.files[i];
      units[unitIndex].cadastralCertificates!.push({
        name: file.name,
        type: file.type,
        size: file.size,
        file,
      });
    }
    input.value = '';
    this.emitUnitsUpdate(units);
  }

  removeUnitCertificate(unitIndex: number, docIndex: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.cadastralCertificates?.[docIndex]) return;
    units[unitIndex].cadastralCertificates!.splice(docIndex, 1);
    this.emitUnitsUpdate(units);
  }

  // ─── Unit-level RRR editing ────────────────────────────────

  addUnitRRREntry(unitIndex: number): void {
    const dialogRef = this.dialog.open(AddRightHolderComponent, {
      width: '680px',
      maxWidth: '90vw',
      data: { context: 'building-unit' },
      autoFocus: false,
      panelClass: 'arh-dark-dialog',
    });

    dialogRef.afterClosed().subscribe((result: AddRightHolderResult | null) => {
      if (!result) return;
      const newRrrId = `URRR-${Date.now().toString(36).toUpperCase()}`;
      const units = this.cloneUnits();
      if (!units[unitIndex]) return;
      const newEntry: RRREntry = {
        rrrId: newRrrId,
        type: RightType.OWN_STR,
        holder: result.partyFullName || result.partyName,
        holderId: result.partyId,
        holderType: result.partyType,
        holderRegType: result.regType,
        holderRegNumber: result.regNumber,
        share: 0,
        validFrom: new Date().toISOString().split('T')[0],
        validTo: '',
        documentRef: '',
        documents: [],
        restrictions: [],
        responsibilities: [],
      };
      this.rrrCreateRequested.emit({
        suId: units[unitIndex].unitId,
        entry: newEntry,
        unitIndex,
      });
    });
  }

  confirmRemoveUnitRRREntry(unitIndex: number, entryIndex: number): void {
    const entry = this.buildingInfo()?.units?.[unitIndex]?.rrr?.entries?.[entryIndex];
    if (!entry) return;

    if (entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      if (
        confirm('Are you sure you want to terminate this RRR entry? This action cannot be undone.')
      ) {
        this.rrrDeleteRequested.emit({ baUnitId, unitIndex });
      }
    } else {
      if (confirm('Are you sure you want to delete this unsaved RRR entry?')) {
        const units = this.cloneUnits();
        units[unitIndex].rrr.entries.splice(entryIndex, 1);
        this.emitUnitsUpdate(units);
      }
    }
  }

  removeUnitRRREntry(unitIndex: number, entryIndex: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]) return;
    units[unitIndex].rrr.entries.splice(entryIndex, 1);
    this.emitUnitsUpdate(units);
  }

  onUnitRRRFieldChange(
    unitIndex: number,
    entryIndex: number,
    field: keyof RRREntry,
    value: any,
  ): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]) return;
    (units[unitIndex].rrr.entries[entryIndex] as any)[field] = value;
    this.emitUnitsUpdate(units);

    const entry = units[unitIndex].rrr.entries[entryIndex];
    if (entry && entry.rrrId.startsWith('BU-') && field === 'type') {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      this.rrrUpdateRequested.emit({ baUnitId, entry, unitIndex });
    }
  }

  onUnitRRRFieldBlur(unitIndex: number, entryIndex: number, field: string): void {
    const unit = this.buildingInfo()?.units?.[unitIndex];
    const entry = unit?.rrr?.entries?.[entryIndex];
    if (entry && entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      this.rrrUpdateRequested.emit({ baUnitId, entry, unitIndex });
    }
  }

  onUnitRRRDocumentUpload(unitIndex: number, entryIndex: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const unit = this.buildingInfo()?.units?.[unitIndex];
    const entry = unit?.rrr?.entries?.[entryIndex];
    if (!entry) return;

    const files = Array.from(input.files);
    if (entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      for (const file of files) {
        this.rrrDocumentUploadRequested.emit({
          baUnitId,
          file,
          name: file.name,
          entryIndex,
          unitIndex,
        });
      }
    } else {
      const units = this.cloneUnits();
      const docs = [...(units[unitIndex].rrr.entries[entryIndex].documents || [])];
      for (const f of files) {
        docs.push({ name: f.name, type: f.type, size: f.size, file: f });
      }
      units[unitIndex].rrr.entries[entryIndex].documents = docs;
      this.emitUnitsUpdate(units);
    }
    input.value = '';
  }

  removeUnitRRRDocument(unitIndex: number, entryIndex: number, docIndex: number): void {
    const unit = this.buildingInfo()?.units?.[unitIndex];
    const entry = unit?.rrr?.entries?.[entryIndex];
    const doc = entry?.documents?.[docIndex];
    if (!entry || !doc) return;

    if (doc.docLinkId) {
      this.rrrDocumentDeleteRequested.emit({
        docLinkId: doc.docLinkId,
        entryIndex,
        docIndex,
        unitIndex,
      });
    } else {
      const units = this.cloneUnits();
      if (!units[unitIndex]?.rrr?.entries?.[entryIndex]?.documents?.[docIndex]) return;
      units[unitIndex].rrr.entries[entryIndex].documents.splice(docIndex, 1);
      this.emitUnitsUpdate(units);
    }
  }

  addUnitRestriction(unitIndex: number, entryIndex: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]) return;
    units[unitIndex].rrr.entries[entryIndex].restrictions.push({
      type: RestrictionType.RES_EAS,
      description: '',
      validFrom: '',
      validTo: '',
    });
    this.emitUnitsUpdate(units);
  }

  removeUnitRestriction(unitIndex: number, entryIndex: number, ri: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]) return;
    units[unitIndex].rrr.entries[entryIndex].restrictions.splice(ri, 1);
    this.emitUnitsUpdate(units);
  }

  onUnitRestrictionChange(
    unitIndex: number,
    entryIndex: number,
    ri: number,
    field: keyof RRRRestriction,
    value: any,
  ): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]?.restrictions[ri]) return;
    (units[unitIndex].rrr.entries[entryIndex].restrictions[ri] as any)[field] = value;
    this.emitUnitsUpdate(units);
  }

  addUnitResponsibility(unitIndex: number, entryIndex: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]) return;
    units[unitIndex].rrr.entries[entryIndex].responsibilities.push({
      type: ResponsibilityType.RSP_MAINT,
      description: '',
      validFrom: '',
      validTo: '',
    });
    this.emitUnitsUpdate(units);
  }

  removeUnitResponsibility(unitIndex: number, entryIndex: number, ri: number): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]) return;
    units[unitIndex].rrr.entries[entryIndex].responsibilities.splice(ri, 1);
    this.emitUnitsUpdate(units);
  }

  onUnitResponsibilityChange(
    unitIndex: number,
    entryIndex: number,
    ri: number,
    field: keyof RRRResponsibility,
    value: any,
  ): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]?.rrr?.entries[entryIndex]?.responsibilities[ri]) return;
    (units[unitIndex].rrr.entries[entryIndex].responsibilities[ri] as any)[field] = value;
    this.emitUnitsUpdate(units);
  }

  // ─── Spatial field editing ──────────────────────────────────

  onSpatialFieldChange(field: keyof SpatialInfo, value: any): void {
    const info = this.buildingInfo();
    if (!info) return;
    const updated: SpatialInfo = { ...info.spatial, [field]: value };
    this.spatialChanged.emit(updated);
  }

  // ─── Physical Attributes editing ────────────────────────────

  onPhysicalFieldChange(field: keyof PhysicalAttributes, value: any): void {
    const info = this.buildingInfo();
    if (!info) return;
    const updated: PhysicalAttributes = { ...info.physicalAttributes, [field]: value };
    this.physicalChanged.emit(updated);
  }

  // ─── Utilities & Services editing ───────────────────────────

  onUtilityFieldChange(field: keyof UtilityInfo, value: string): void {
    const info = this.buildingInfo();
    if (!info) return;
    const current: UtilityInfo = info.utilities ?? {
      electricity: '',
      telephone: '',
      internet: '',
      waterDrink: '',
      water: '',
      drainage: '',
      sanitationSewer: '',
      sanitationGully: '',
      garbageDisposal: '',
    };
    const updated: UtilityInfo = { ...current, [field]: value };
    this.utilitiesChanged.emit(updated);
  }

  // ─── Relationships & Topology editing ───────────────────────

  onRelationshipsFieldChange(field: keyof RelationshipsTopology, value: any): void {
    const info = this.buildingInfo();
    if (!info) return;
    const updated: RelationshipsTopology = { ...info.relationshipsTopology, [field]: value };
    this.relationshipsChanged.emit(updated);
  }

  onTaxValuationFieldChange(field: keyof TaxValuation, value: any): void {
    const info = this.buildingInfo();
    if (!info?.taxValuation) return;
    const updated: TaxValuation = { ...info.taxValuation, [field]: value };
    this.taxValuationChanged.emit(updated);
  }

  // ─── Metadata & Quality editing ─────────────────────────────

  onMetadataFieldChange(field: keyof MetadataQuality, value: any): void {
    const info = this.buildingInfo();
    if (!info) return;
    const updated: MetadataQuality = { ...info.metadataQuality, [field]: value };
    this.metadataChanged.emit(updated);
  }

  // ─── Panel Mode Controls ──────────────────────────────────

  onSaveModelClick(): void {
    this.saveModelRequested.emit();
    this.editMode.set(true);
  }

  onSaveBuilding(): void {
    const info = this.buildingInfo();
    if (!info || this.saving()) return;
    this.saveBuildingRequested.emit(info);
  }

  onDeleteBuilding(): void {
    this.deleteBuildingRequested.emit();
    this.editMode.set(false);
  }

  // ─── Room Selection for Units ─────────────────────────────

  startRoomSelectionForUnit(unitIndex: number): void {
    const info = this.buildingInfo();
    if (!info?.units[unitIndex]) return;
    this.selectingRoomsForUnit.set(unitIndex);
    this.startRoomSelection.emit({
      unitIndex,
      existingRooms: info.units[unitIndex].rooms,
    });
  }

  confirmRoomSelection(): void {
    const unitIndex = this.selectingRoomsForUnit();
    if (unitIndex === null) return;
    const rooms = this.pendingRoomSelection();
    this.finishRoomSelection.emit({ unitIndex, rooms: [...rooms] });

    const units = this.cloneUnits();
    if (units[unitIndex]) {
      units[unitIndex].rooms = [...rooms];
      this.emitUnitsUpdate(units);
    }
    this.selectingRoomsForUnit.set(null);
  }

  cancelRoomSelectionMode(): void {
    this.selectingRoomsForUnit.set(null);
    this.cancelRoomSelection.emit();
  }

  removeRoomFromUnit(unitIndex: number, roomId: string): void {
    const units = this.cloneUnits();
    if (!units[unitIndex]) return;
    units[unitIndex].rooms = units[unitIndex].rooms.filter((r) => r !== roomId);
    this.emitUnitsUpdate(units);
  }

  onUnitCardClick(unit: BuildingUnit): void {
    this.selectedUnit.set(unit);
    this.unitSelected.emit(unit.unitId);
    this.highlightRooms.emit(unit.rooms);
  }

  // ─── Share Validation ──────────────────────────────────────

  openUnitComposition(): void {
    const info = this.buildingInfo();
    const buildingSuId = Number(info?.summary?.buildingId);
    if (!Number.isFinite(buildingSuId)) return;

    const dialogRef = this.dialog.open(UnitCompositionComponent, {
      width: '96vw',
      maxWidth: '1400px',
      height: '86vh',
      data: {
        buildingSuId,
        buildingName: info?.summary?.address || info?.summary?.buildingId,
      },
      autoFocus: false,
    });

    dialogRef.afterClosed().subscribe((changed) => {
      if (changed) this.compositionChanged.emit();
    });
  }

  getTotalShare(): number {
    const info = this.buildingInfo();
    if (!info) return 0;
    return info.rrr.entries.reduce((sum, e) => sum + (e.share || 0), 0);
  }

  getShareWarning(): string {
    const total = this.getTotalShare();
    if (total === 0 || total === 100) return '';
    if (total > 100) return `Total share is ${total}% (exceeds 100%)`;
    return `Total share is ${total}% (${100 - total}% unallocated)`;
  }

  getUnitTotalShare(unitIndex: number): number {
    const info = this.buildingInfo();
    if (!info?.units[unitIndex]) return 0;
    return info.units[unitIndex].rrr.entries.reduce((sum, e) => sum + (e.share || 0), 0);
  }

  getUnitShareWarning(unitIndex: number): string {
    const total = this.getUnitTotalShare(unitIndex);
    if (total === 0 || total === 100) return '';
    if (total > 100) return `Total share is ${total}% (exceeds 100%)`;
    return `Total share is ${total}% (${100 - total}% unallocated)`;
  }

  // ─── Holder Display ────────────────────────────────────────

  getHolderDisplayLabel(entry: RRREntry): string {
    if (entry.holderType) {
      return PARTY_TYPE_DISPLAY[entry.holderType as PartyType] || entry.holderType;
    }
    return '';
  }

  openHolderDetails(entry: RRREntry): void {
    if (!entry.holderId && !entry.holderRegNumber) return;
    this.dialog.open(AddRightHolderComponent, {
      width: '680px',
      maxWidth: '90vw',
      data: {
        context: 'building',
        viewOnly: true,
        holderId: entry.holderId,
        holderType: entry.holderType,
        holderRegType: entry.holderRegType,
        holderRegNumber: entry.holderRegNumber,
        holderName: entry.holder,
      },
      autoFocus: false,
      panelClass: 'arh-dark-dialog',
    });
  }

  openDocument(doc: RRRDocument): void {
    if (!doc.fileUrl) return;
    this.apiService.getPDF(doc.fileUrl).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
      },
      error: () => console.error('Failed to open document:', doc.fileUrl),
    });
  }
}
