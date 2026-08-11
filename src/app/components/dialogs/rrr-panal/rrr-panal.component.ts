//
import {
  Component,
  Inject,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';
import { CivilianComponent } from '../../dialogs/civilian/civilian.component';
import { CompanyComponent } from '../../dialogs/company/company.component';
import { GroupComponent } from '../../dialogs/group/group.component';
import { LegalFirmComponent } from '../legal-firm/legal-firm.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-rrr-panal',
  standalone: true,
  imports: [
    MatDialogModule,
    MatTabsModule,
    ReactiveFormsModule,
    FormsModule,
    MatCardModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    DatePipe,
  ],
  templateUrl: './rrr-panal.component.html',
  styleUrl: './rrr-panal.component.css',
})
export class RrrPanalComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  party_sub_types_array_to_dialog = [{ name: 'Type 1' }, { name: 'Type 2' }, { name: 'Type 3' }]; // example data
  card = { party_sub_type: '' };
  // DATA LOAD OBJECTS
  right_edit_view: any = {
    right_type: '',
    description: '',
    from: '',
    to: '',
    life_time: true,
  };
  civilian = {
    party_registration_type: '',
    registration_number: '',
  };
  mortgage = {
    amount: '',
    interest: '',
    mortgage_type: '',
    ranking: '',
    Mortgage_ID: '',
    Mortgagee: '',
  };
  selected_dialog: any;
  doc_owner: false | undefined;
  doc_owner_pid: number | null = null;
  // DATA ARRAYS
  right_types_array = ['Ownership', 'Mortgage'];

  ownership = {
    ownership_type: '',
  };
  party_sub_types_array: any = [];
  existing_admin_source: any = [];
  source_types_array: any = [];
  rights_array: any = [];

  administrative_source: any = {};
  // BACKEND GET DATA ARRAYS
  mortgage_types_array: any = [];
  ownership_types_array: any = [];
  right_share_types_array: any = [];

  party_cards: any[] = [];
  adeded_party_cards: any[] = [];
  show_presentage_inputs = false;
  data_of_aded_party: any = {};
  ba_unit: any;

  show_party_add = false;

  // Issue #8: audit history
  history_data: any[] = [];
  history_loading = false;

  add_party = {
    party_sub_type: '',
    share_percentage: '',
    share_type: '',
  };

  ngOnInit(): void {
    this.loadMortgageTypes();
    this.loadOwnershipTypes();
    this.loadPartySubTypes();
    this.loadRightshareTypes();
    this.getSourceTypes();
    this.getExistingAdminSourceData();
    this.getTabLabel();
    this.loadHistory();
  }

  // featureId: string;

  constructor(
    // @Inject(MAT_DIALOG_DATA) public data: any,
    public dialogRef: MatDialogRef<RrrPanalComponent>,
    @Inject(MAT_DIALOG_DATA) public data: { feature_id: string },
    private apiService: APIsService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
  ) {
    this.getBAUnitID();
  }

  getTabLabel() {
    return this.existing_admin_source.length > 0
      ? 'Refer To An Existing Source'
      : 'Refer To An Existing Source (No Data)';
  }
  getBAUnitID() {
    this.apiService.getBAUnitID(this.data.feature_id).subscribe((res) => {
      console.log(res);
      // @ts-ignore
      this.ba_unit = res.ba_unit_id;

      this.cdr.markForCheck();
    });
  }

  // ADD PARTY CARD

  addNewParty() {
    const newCard = {
      id: this.party_cards.length + 1,
      title: `Card ${this.party_cards.length + 1}`,
      content: 'This is a dynamically added card.',
      party_major_type: '',
      party_sub_type: '',
      share_type: '',
    };
    this.party_cards.push(newCard);
  }

  addNewPartyOneCard() {
    this.show_party_add = true;
  }

  loadMortgageTypes() {
    this.apiService.loadMortgageTypes().subscribe((res) => {
      this.mortgage_types_array = res;

      this.cdr.markForCheck();
    });
  }

  getSourceTypes() {
    this.apiService.getSourceTypes().subscribe((res) => {
      this.source_types_array = res;

      this.cdr.markForCheck();
    });
  }

  civilianShowButton(presentage: any) {
    if (this.right_edit_view.life_time == true) {
      this.right_edit_view.to = null;
    }
    if (this.right_edit_view.description == '') {
      this.right_edit_view.description = null;
    }
    let input_data = {
      party_name: this.data_of_aded_party.party_name,
      share: presentage,
      party_type: this.add_party.party_sub_type,
      date_start: this.right_edit_view.from,
      date_end: this.right_edit_view.to,
      description: this.right_edit_view.description,
      party: this.data_of_aded_party.pid,
      right_type: this.ownership.ownership_type,
      share_type: this.add_party.share_type,
    };
    this.adeded_party_cards.push(input_data);
    ((this.add_party.share_type = ''), (this.add_party.share_percentage = ''));
    this.show_party_add = false;
    this.data_of_aded_party.party_name = '';
  }

  loadPartySubTypes() {
    this.apiService.loadPartySubTypes().subscribe((res) => {
      this.party_sub_types_array = res;

      this.cdr.markForCheck();
    });
  }

  loadOwnershipTypes() {
    this.apiService.loadOwnershipTypes().subscribe((res) => {
      this.ownership_types_array = res;

      this.cdr.markForCheck();
    });
  }

  loadRightshareTypes() {
    this.apiService.loadRightshareTypes().subscribe((res) => {
      console.log(res);
      this.right_share_types_array = res;

      this.cdr.markForCheck();
    });
  }

  onPartySubTypeChange(selectedValue: string) {
    this.selected_dialog = selectedValue;
  }

  toggleLifeTimeSelection() {}
  // Open dialog method
  openPartyTypeDialog(partyType: string) {
    if (this.add_party.party_sub_type) {
      if (this.add_party.party_sub_type == 'Group') {
        const dialogRef = this.dialog.open(GroupComponent, {
          minWidth: ' 85%',
          maxWidth: '450px',
          data: { partyType: 'Civilian' }, // Pass the selected value to the dialog
        });

        dialogRef.afterClosed().subscribe((result) => {
          if (result) {
            console.log('Dialog result:', result.party_name);
          }
        });
      }
      // ********************************
      if (this.add_party.party_sub_type == 'Company') {
        const dialogRef = this.dialog.open(CompanyComponent, {
          minWidth: ' 85%',
          maxWidth: '450px',
          data: { partyType: partyType, path: 'full' }, // Pass the selected value to the dialog
        });

        dialogRef.afterClosed().subscribe((result) => {
          if (result) {
            this.data_of_aded_party = result.data;
            this.show_presentage_inputs = true;
          }

          this.cdr.markForCheck();
        });
      }
      if (this.add_party.party_sub_type == 'Ministry') {
        const dialogRef = this.dialog.open(LegalFirmComponent, {
          minWidth: ' 85%',
          maxWidth: '450px',
          data: { partyType: partyType }, // Pass the selected value to the dialog
        });

        dialogRef.afterClosed().subscribe((result) => {
          if (result) {
            console.log('Dialog result:', result); // You can handle the result here
          }
        });
      }
      if (this.add_party.party_sub_type == 'Civilian') {
        const dialogRef = this.dialog.open(CivilianComponent, {
          minWidth: ' 85%',
          maxWidth: '450px',
          data: { partyType: partyType, path: 'full' }, // Pass the selected value to the dialog
        });

        dialogRef.afterClosed().subscribe((result) => {
          if (result) {
            console.log('Dialog result:', result);
            this.data_of_aded_party = result.data;
            this.show_presentage_inputs = true;
          }

          this.cdr.markForCheck();
        });
      }
    } else {
      this.notificationService.showError('Please select type');
    }
  }

  getExistingAdminSourceData() {
    this.apiService.getExistingAdminSourceData(this.data.feature_id).subscribe((res: any) => {
      console.log(res);
      // Response shape: { history_su_id, records: [ { ba_unit_id, admin_sources: [], rrrs: [] } ] }
      const records: any[] = res?.records ?? [];
      const allAdminSources: any[] = [];
      for (const record of records) {
        for (const src of record.admin_sources ?? []) {
          allAdminSources.push(src);
        }
      }
      this.existing_admin_source = allAdminSources;
      this.cdr.markForCheck();
    });
  }

  onEdit(item: any) {}

  openPdfInNewTab(item: any) {
    console.log(item.file_path);
    this.apiService.getPDF(item.file_url).subscribe((res) => {
      const fileURL = URL.createObjectURL(res);
      window.open(fileURL, '_blank');
    });
  }

  getCivilianUserData() {
    this.apiService.getCivilianPartyData(this.administrative_source).subscribe((res) => {
      if (Array.isArray(res) && res.length > 0) {
        const firstEntry = res[0];
        console.log(firstEntry);
        ((this.administrative_source.party_full_name = firstEntry.party_full_name),
          (this.administrative_source.document_owner_id = firstEntry.pid));
      } else {
        this.notificationService.showWarning('No any records found');
      }
    });
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      console.log('Selected file:', file); // Debugging log
      this.administrative_source.file_path = file;
    } else {
      console.error('No file selected');
    }
  }

  // Issue #8: load audit history for this parcel
  loadHistory() {
    this.history_loading = true;
    this.apiService.getRRRHistory(this.data.feature_id).subscribe({
      next: (res: any[]) => {
        this.history_data = res;
        this.history_loading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.history_loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  // Issue #8: terminate (soft-delete) a right and refresh the panel data
  terminateRRR(rrrId: number) {
    if (!confirm('Terminate this right? This action cannot be undone from the UI.')) return;
    this.apiService.terminateRRR(rrrId).subscribe({
      next: () => {
        this.notificationService.showSuccess('Right terminated successfully.');
        this.getExistingAdminSourceData();
        this.loadHistory();
      },
      error: (err: any) => {
        this.notificationService.showError(err?.error?.error || 'Failed to terminate right.');
      },
    });
  }

  toggleSelection(card: any) {
    console.log(card);

    if (this.doc_owner_pid === card.party) {
      console.log(this.doc_owner_pid);

      this.doc_owner_pid = null; // Uncheck if already selected
    } else {
      this.doc_owner_pid = card.party; // Select new checkbox
    }
  }

  SubmitAll() {
    if (
      this.ownership.ownership_type &&
      this.right_edit_view.from &&
      this.administrative_source.admin_source_type &&
      this.administrative_source.acceptance_date &&
      this.administrative_source.reference_no
    ) {
      if (this.administrative_source.description == '') {
        this.administrative_source.description = null;
      }
      if (!this.doc_owner_pid) {
        this.notificationService.showError('Please select DOC owner');
      } else {
        const isMortgage = this.right_edit_view.right_type === 'Mortgage';
        let save_data: any = {
          admin_source_type: this.administrative_source.admin_source_type,
          reference_no: this.administrative_source.reference_no,
          acceptance_date: this.administrative_source.acceptance_date,
          exte_arch_ref: this.administrative_source.exte_arch_ref,
          source_description: this.administrative_source.description,
          doc_owner: this.doc_owner_pid,
          ba_unit_id: this.ba_unit,
          su_id: this.data.feature_id,
          code: 'la_rrr_sl_rights',
          la_ba_unit_type: 'basicPropertyUnit',
          rights: this.adeded_party_cards,
          mortgage: isMortgage
            ? {
                amount: this.mortgage.amount || null,
                interest: this.mortgage.interest || null,
                ranking: this.mortgage.ranking || null,
                mortgage_type: this.mortgage.mortgage_type || null,
                mortgage_ref_id: this.mortgage.Mortgage_ID || null,
                mortgagee: this.mortgage.Mortgagee || null,
              }
            : null,
        };
        // const formData = new FormData();
        // formData.append("admin_source_type", this.administrative_source.admin_source_type);
        // formData.append("reference_no", this.administrative_source.reference_no);
        // formData.append("acceptance_date", this.administrative_source.acceptance_date);
        // formData.append("exte_arch_ref", this.administrative_source.exte_arch_ref);
        // formData.append("source_description", this.administrative_source.source_description);
        // formData.append("doc_owner", this.doc_owner_pid);
        // formData.append("ba_unit_id", this.ba_unit);
        // formData.append("description", this.administrative_source.description);
        // formData.append("su_id", this.data.feature_id);
        // formData.append("code", 'la_rrr_sl_rights');
        // formData.append("la_ba_unit_type", 'basicPropertyUnit');

        // formData.append('rights', JSON.stringify(this.adeded_party_cards));
        // console.log(this.doc_owner_pid)

        // Append the file if it exists
        // if (this.administrative_source.file_path) {
        //   formData.append("file_path", this.administrative_source.file_path);
        // } else {
        //   this.notificationService.showError("No file selected!");
        //   return;
        // }
        this.apiService.postAdminSource(save_data).subscribe(
          (response: any) => {
            console.log(response);
            this.notificationService.showSuccess('Data saved successfully');
            this.administrative_source = {};
            this.adeded_party_cards = [];

            this.cdr.markForCheck();
          },
          (error: any) => {
            console.error('Error saving administrative info:', error);
            this.handleApiErrors(error);
          },
        );
      }
    } else {
      this.notificationService.showError('Please fill all required fields');
    }
  }

  /**
   * Handles API errors and displays appropriate toasts.
   */
  handleApiErrors(error: any) {
    if (error.error) {
      if (error.error.email) {
        console.log(error.error.email[0]);
        this.notificationService.showError(error.error.email[0]);
      }
      if (error.error.specific_tp) {
        console.log(error.error.specific_tp[0]);

        this.notificationService.showError(error.error.specific_tp[0]);
      }
    } else {
      this.notificationService.showError('Data not saved due to an unknown error.');
    }
  }

  addDocumentOwner() {
    this.administrative_source.document_owner = this.administrative_source.party_full_name;
  }
  removeCard(index: number) {
    this.adeded_party_cards.splice(index, 1); // Removes the item at the given index
  }
  closeDialog(): void {
    this.dialogRef.close();
  }
}
