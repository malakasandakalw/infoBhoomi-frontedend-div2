import {
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { LandSectionPermissions } from '../../../core/constant';

import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';

import {
  LandParcelInfo,
  createDefaultLandParcel,
  LandUse,
  LAND_USE_DISPLAY,
  TenureType,
  TENURE_TYPE_DISPLAY,
  ParcelType,
  PARCEL_TYPE_DISPLAY,
  BoundaryType,
  BOUNDARY_TYPE_DISPLAY,
  ZoningCategory,
  ZONING_CATEGORY_DISPLAY,
  ParcelStatus,
  PARCEL_STATUS_DISPLAY,
  SoilType,
  SOIL_TYPE_DISPLAY,
  RightType,
  RIGHT_TYPE_DISPLAY,
  RestrictionType,
  RESTRICTION_TYPE_DISPLAY,
  ResponsibilityType,
  RESPONSIBILITY_TYPE_DISPLAY,
  AccuracyLevel,
  ACCURACY_LEVEL_DISPLAY,
  SurveyMethod,
  SURVEY_METHOD_DISPLAY,
  PartyType,
  PARTY_TYPE_DISPLAY,
  ParcelIdentification,
  ParcelSpatial,
  ParcelPhysical,
  ParcelZoning,
  ParcelValuation,
  ParcelRelationships,
  ParcelMetadata,
  RRREntry,
  RRRInfo,
  RRRDocument,
} from '../../../models/land-parcel.model';
import {
  AddRightHolderComponent,
  AddRightHolderResult,
} from '../../dialogs/add-right-holder/add-right-holder.component';
import { APIsService } from '../../../services/api.service';

export type LandParcelSaveRequest = LandParcelInfo & { __dirtyFields?: string[] };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-land-info-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './land-info-panel.component.html',
  styleUrls: ['./land-info-panel.component.css'],
})
export class LandInfoPanelComponent {
  private dialog = inject(MatDialog);
  private apiService = inject(APIsService);
  // --- Inputs ---
  parcelInfo = input<LandParcelInfo | null>(null);
  sectionPerms = input<Record<number, any>>({});
  saving = input<boolean>(false);

  // --- Permission helpers ---
  readonly LAND_PERMS = LandSectionPermissions;

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

  // --- Outputs ---
  identificationChanged = output<ParcelIdentification>();
  spatialChanged = output<ParcelSpatial>();
  physicalChanged = output<ParcelPhysical>();
  zoningChanged = output<ParcelZoning>();
  rrrChanged = output<RRRInfo>();
  valuationChanged = output<ParcelValuation>();
  relationshipsChanged = output<ParcelRelationships>();
  metadataChanged = output<ParcelMetadata>();
  saveParcelRequested = output<LandParcelSaveRequest>();
  deleteParcelRequested = output<void>();
  newParcelRequested = output<LandParcelInfo>();
  rrrCreateRequested = output<{ suId: number | string; entry: RRREntry }>();
  rrrUpdateRequested = output<{ baUnitId: number; entry: RRREntry }>();
  rrrDeleteRequested = output<{ baUnitId: number }>();
  rrrDocumentUploadRequested = output<{
    baUnitId: number;
    file: File;
    name: string;
    entryIndex: number;
  }>();
  rrrDocumentDeleteRequested = output<{
    docLinkId: number;
    entryIndex: number;
    docIndex: number;
  }>();

  // --- Enum Options ---
  landUseOptions = Object.values(LandUse);
  tenureTypeOptions = Object.values(TenureType);
  parcelTypeOptions = Object.values(ParcelType);
  boundaryTypeOptions = Object.values(BoundaryType);
  zoningCategoryOptions = Object.values(ZoningCategory);
  parcelStatusOptions = Object.values(ParcelStatus);
  soilTypeOptions = Object.values(SoilType);
  rightTypeOptions = Object.values(RightType);
  restrictionTypeOptions = Object.values(RestrictionType);
  responsibilityTypeOptions = Object.values(ResponsibilityType);
  accuracyLevelOptions = Object.values(AccuracyLevel);
  surveyMethodOptions = Object.values(SurveyMethod);

  // --- Display Maps ---
  landUseDisplayMap = LAND_USE_DISPLAY;
  tenureTypeDisplayMap = TENURE_TYPE_DISPLAY;
  parcelTypeDisplayMap = PARCEL_TYPE_DISPLAY;
  boundaryTypeDisplayMap = BOUNDARY_TYPE_DISPLAY;
  zoningCategoryDisplayMap = ZONING_CATEGORY_DISPLAY;
  parcelStatusDisplayMap = PARCEL_STATUS_DISPLAY;
  soilTypeDisplayMap = SOIL_TYPE_DISPLAY;
  rightTypeDisplayMap = RIGHT_TYPE_DISPLAY;
  restrictionTypeDisplayMap = RESTRICTION_TYPE_DISPLAY;
  responsibilityTypeDisplayMap = RESPONSIBILITY_TYPE_DISPLAY;
  accuracyLevelDisplayMap = ACCURACY_LEVEL_DISPLAY;
  surveyMethodDisplayMap = SURVEY_METHOD_DISPLAY;

  // --- Local RRR State (avoids parent round-trip delay) ---
  rrrEntries = signal<RRREntry[]>([]);
  private dirtyFields = signal<Set<string>>(new Set());
  private currentParcelId: string | null = null;

  // --- Physical & Environmental lookup options (loaded from backend lst_* tables) ---
  vegetationOptions = signal<string[]>([]);
  waterSupplyOptions = signal<string[]>([]);
  electricityOptions = signal<string[]>([]);
  drainageOptions = signal<string[]>([]);
  sanitationSewerOptions = signal<string[]>([]);
  sanitationGullyOptions = signal<string[]>([]);
  garbageDisposalOptions = signal<string[]>([]);

  constructor() {
    // Sync local RRR entries from the input signal whenever it changes
    effect(() => {
      const info = this.parcelInfo();
      const parcelId = info?.identification.parcelId ?? null;
      if (parcelId !== this.currentParcelId) {
        this.currentParcelId = parcelId;
        this.dirtyFields.set(new Set());
      }
      this.rrrEntries.set(info ? [...info.rrr.entries] : []);
    });

    this.loadPhysicalEnvLookups();
  }

  /**
   * Load all dropdown options for the Physical & Environmental section.
   * Backend endpoints may return either a bare array `[{id, name}, ...]`
   * or a DRF-paginated object `{count, next, previous, results: [...]}`.
   * We handle both shapes.
   */
  private loadPhysicalEnvLookups(): void {
    const setFromResp = (sig: ReturnType<typeof signal<string[]>>) => (resp: any) => {
      const rows: any[] = Array.isArray(resp)
        ? resp
        : Array.isArray(resp?.results)
          ? resp.results
          : [];
      sig.set(rows.map((r) => r?.name).filter((n): n is string => typeof n === 'string' && !!n));
    };
    this.apiService.getVegetationOptions().subscribe(setFromResp(this.vegetationOptions));
    this.apiService.getWaterSupply().subscribe(setFromResp(this.waterSupplyOptions));
    this.apiService.getElectricityOptions().subscribe(setFromResp(this.electricityOptions));
    this.apiService.getDrainageOptions().subscribe(setFromResp(this.drainageOptions));
    this.apiService.getSanitationSewerage().subscribe(setFromResp(this.sanitationSewerOptions));
    this.apiService.getGullyOptions().subscribe(setFromResp(this.sanitationGullyOptions));
    this.apiService.getGarbageOptions().subscribe(setFromResp(this.garbageDisposalOptions));
  }

  /** Update local RRR state immediately and notify parent */
  private updateRRR(entries: RRREntry[]): void {
    this.rrrEntries.set(entries);
    this.rrrChanged.emit({ entries });
  }

  private markDirty(section: string, field: string): void {
    this.dirtyFields.update((fields) => {
      const next = new Set(fields);
      next.add(`${section}.${field}`);
      return next;
    });
  }

  // --- UI State ---
  expandedSections = signal<Set<string>>(new Set(['hierarchy', 'identification']));
  expandedRRRId = signal<string | null>(null);

  isSectionExpanded(section: string): boolean {
    return this.expandedSections().has(section);
  }

  toggleSection(section: string): void {
    this.expandedSections.update((set) => {
      const next = new Set(set);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  toggleRRRExpand(rrrId: string): void {
    this.expandedRRRId.update((current) => (current === rrrId ? null : rrrId));
  }

  // --- Change Handlers ---

  onIdentificationFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('identification', field);
    const updated = { ...info.identification, [field]: value };
    this.identificationChanged.emit(updated);
  }

  onSpatialFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('spatial', field);
    const updated = { ...info.spatial, [field]: value };
    this.spatialChanged.emit(updated);
  }

  onPhysicalFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('physical', field);
    const updated = { ...info.physical, [field]: value };
    this.physicalChanged.emit(updated);
  }

  onZoningFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('zoning', field);
    const updated = { ...info.zoning, [field]: value };
    this.zoningChanged.emit(updated);
  }

  onValuationFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('valuation', field);
    const updated = { ...info.valuation, [field]: value };
    this.valuationChanged.emit(updated);
  }

  onRelationshipsFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('relationships', field);
    const updated = { ...info.relationships, [field]: value };
    this.relationshipsChanged.emit(updated);
  }

  onMetadataFieldChange(field: string, value: any): void {
    const info = this.parcelInfo();
    if (!info) return;
    this.markDirty('metadata', field);
    const updated = { ...info.metadata, [field]: value };
    this.metadataChanged.emit(updated);
  }

  // --- RRR Handlers ---

  onRRRFieldChange(entryIndex: number, field: string, value: any): void {
    const entries = this.rrrEntries().map((e, i) =>
      i === entryIndex ? { ...e, [field]: value } : e,
    );
    this.updateRRR(entries);

    // Dropdowns emit save requests immediately on change
    const entry = entries[entryIndex];
    if (entry && entry.rrrId.startsWith('BU-') && field === 'type') {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      this.rrrUpdateRequested.emit({ baUnitId, entry });
    }
  }

  onRRRFieldBlur(entryIndex: number, field: string): void {
    const entry = this.rrrEntries()[entryIndex];
    if (entry && entry.rrrId.startsWith('BU-')) {
      const baUnitId = Number(entry.rrrId.replace('BU-', ''));
      this.rrrUpdateRequested.emit({ baUnitId, entry });
    }
  }

  addRRREntry(): void {
    if (!this.parcelInfo()) return;

    const dialogRef = this.dialog.open(AddRightHolderComponent, {
      width: '680px',
      maxWidth: '90vw',
      data: { context: 'land' },
      autoFocus: false,
      panelClass: 'arh-dark-dialog',
    });

    dialogRef.afterClosed().subscribe((result: AddRightHolderResult | null) => {
      if (!result) return;
      const tempRrrId = `LRRR-${Date.now()}`;
      const newEntry: RRREntry = {
        rrrId: tempRrrId,
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
      // Emit immediate creation request to parent
      this.rrrCreateRequested.emit({
        suId: this.parcelInfo()?.identification.parcelId || 0,
        entry: newEntry,
      });
    });
  }

  // --- Share Validation ---

  getTotalShare(): number {
    return this.rrrEntries().reduce((sum, e) => sum + (e.share || 0), 0);
  }

  getShareWarning(): string {
    const total = this.getTotalShare();
    if (total === 0 || total === 100) return '';
    if (total > 100) return `Total share is ${total}% (exceeds 100%)`;
    return `Total share is ${total}% (${100 - total}% unallocated)`;
  }

  // --- Holder Display ---

  partyTypeDisplayMap = PARTY_TYPE_DISPLAY;

  getHolderDisplayLabel(entry: any): string {
    if (entry.holderType) {
      return PARTY_TYPE_DISPLAY[entry.holderType as PartyType] || entry.holderType;
    }
    return '';
  }

  openHolderDetails(entry: any): void {
    if (!entry.holderId && !entry.holderRegNumber) return;
    this.dialog.open(AddRightHolderComponent, {
      width: '680px',
      maxWidth: '90vw',
      // Pass the existing holder identifiers; the dialog uses these in
      // viewOnly mode to fetch and display the party details, skipping
      // the "select type / enter ID" wizard.
      data: {
        context: 'land',
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

  // --- Document uploads ---

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

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
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

  onRestrictionChange(
    entryIndex: number,
    restrictionIndex: number,
    field: string,
    value: any,
  ): void {
    const entries = this.rrrEntries().map((e, i) => {
      if (i !== entryIndex) return e;
      const restrictions = e.restrictions.map((r, ri) =>
        ri === restrictionIndex ? { ...r, [field]: value } : r,
      );
      return { ...e, restrictions };
    });
    this.updateRRR(entries);
  }

  addRestriction(entryIndex: number): void {
    const entries = this.rrrEntries().map((e, i) => {
      if (i !== entryIndex) return e;
      return {
        ...e,
        restrictions: [
          ...e.restrictions,
          { type: RestrictionType.RES_EAS, description: '', validFrom: '', validTo: '' },
        ],
      };
    });
    this.updateRRR(entries);
  }

  removeRestriction(entryIndex: number, restrictionIndex: number): void {
    const entries = this.rrrEntries().map((e, i) => {
      if (i !== entryIndex) return e;
      return { ...e, restrictions: e.restrictions.filter((_, ri) => ri !== restrictionIndex) };
    });
    this.updateRRR(entries);
  }

  onResponsibilityChange(
    entryIndex: number,
    responsibilityIndex: number,
    field: string,
    value: any,
  ): void {
    const entries = this.rrrEntries().map((e, i) => {
      if (i !== entryIndex) return e;
      const responsibilities = e.responsibilities.map((r, ri) =>
        ri === responsibilityIndex ? { ...r, [field]: value } : r,
      );
      return { ...e, responsibilities };
    });
    this.updateRRR(entries);
  }

  addResponsibility(entryIndex: number): void {
    const entries = this.rrrEntries().map((e, i) => {
      if (i !== entryIndex) return e;
      return {
        ...e,
        responsibilities: [
          ...e.responsibilities,
          { type: ResponsibilityType.RSP_MAINT, description: '', validFrom: '', validTo: '' },
        ],
      };
    });
    this.updateRRR(entries);
  }

  removeResponsibility(entryIndex: number, responsibilityIndex: number): void {
    const entries = this.rrrEntries().map((e, i) => {
      if (i !== entryIndex) return e;
      return {
        ...e,
        responsibilities: e.responsibilities.filter((_, ri) => ri !== responsibilityIndex),
      };
    });
    this.updateRRR(entries);
  }

  // --- Actions ---

  createNewParcel(): void {
    const parcel = createDefaultLandParcel();
    this.newParcelRequested.emit(parcel);
  }

  onSaveParcel(): void {
    const info = this.parcelInfo();
    if (info && !this.saving()) {
      this.saveParcelRequested.emit({ ...info, __dirtyFields: Array.from(this.dirtyFields()) });
    }
  }

  onDeleteParcel(): void {
    this.deleteParcelRequested.emit();
  }

  // --- Formatters ---

  formatArea(value: number | undefined): string {
    if (!value) return '0.00 m²';
    const sqm = value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const acres = (value * 0.000247105).toFixed(4);
    return `${sqm} m²  |  ${acres} acres`;
  }

  formatPerimeter(value: number | undefined): string {
    if (!value) return '0.00 m';
    const m = value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (value >= 1000) {
      const km = (value / 1000).toFixed(3);
      return `${m} m  |  ${km} km`;
    }
    return `${m} m`;
  }

  formatCurrency(value: number | undefined): string {
    if (!value) return '$0';
    return (
      '$' + value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    );
  }
}
