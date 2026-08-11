import {
  Component,
  Inject,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
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
import { NgSelectModule } from '@ng-select/ng-select';
import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';

declare var bootstrap: any;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-manage-ass-wards',
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
    NgSelectModule,
  ],
  templateUrl: './manage-ass-wards.component.html',
  styleUrl: './manage-ass-wards.component.css',
})
export class ManageAssWardsComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  ass_wards_list: any = [];
  selected_ass_ward: any;
  admin_password = '';
  ass_ward_name = '';

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: any,
    public dialogRef: MatDialogRef<ManageAssWardsComponent>,
    private apiService: APIsService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
  ) {}

  async ngOnInit() {
    await this.getAssWardsList();
  }

  async getAssWardsList() {
    this.apiService.getAssessWardList().subscribe((res) => {
      this.ass_wards_list = res;
      console.log(res);
      for (let item of this.ass_wards_list) {
        item.edit = false;
      }

      this.cdr.markForCheck();
    });
  }

  editAssWard(item: any) {
    item.edit = true;
  }

  openDeleteModal(data: any) {
    this.selected_ass_ward = data;
    const modalElement = document.getElementById('confirmDeleteModal');
    let modal: any;
    if (modalElement) {
      modal = new bootstrap.Modal(modalElement, {
        backdrop: false, // Disable backdrop to prevent overlay issues
        keyboard: true,
      });
    }
    modal.show();
  }

  updateAssessmentWard(selected_ass_ward: any) {
    selected_ass_ward.edit = false;
    let input_data = {
      ward_name: selected_ass_ward.ward_name,
    };
    this.apiService.updateAssessmentWard(input_data, selected_ass_ward.id).subscribe(
      (response: any) => {
        console.log(response);
        this.notificationService.showSuccess('Data saved successfully');
      },
      (error: any) => {
        console.error('Error saving administrative info:', error);
        if (error?.error?.non_field_errors) {
          this.notificationService.showError('Data not saved');
        } else {
          this.notificationService.showError('Data not saved');
        }
      },
    );
  }

  SubmitAll() {
    let input_data = {
      ward_name: this.ass_ward_name,
    };
    this.apiService.createAssesmentWard(input_data).subscribe(
      (response: any) => {
        this.ass_ward_name = '';
        this.getAssWardsList();
        this.notificationService.showSuccess('Data saved successfully');

        this.cdr.markForCheck();
      },
      (error: any) => {
        console.error('Error saving administrative info:', error);
        this.notificationService.showError(error.error?.error || 'Data not saved');
        // if (error?.error?.non_field_errors) {
        //   this.notificationService.showError('Data not saved');
        // } else {
        //   this.notificationService.showError('Data not saved');
        // }
      },
    );
  }

  closeDialog(): void {
    this.dialogRef.close();
  }
}
