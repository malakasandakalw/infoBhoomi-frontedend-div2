import {
  Component,
  Inject,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';

import { FormsModule, ReactiveFormsModule } from '@angular/forms';

import {
  MatDialog,
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA,
} from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { NgSelectModule } from '@ng-select/ng-select';

import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';

declare var bootstrap: any;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-share-layer',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatTabsModule,
    MatCardModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    NgSelectModule,
  ],
  templateUrl: './share-layer.component.html',
  styleUrl: './share-layer.component.css',
})
export class ShareLayerComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  // UI/selection lists
  users_list: any[] = []; // displayed (filtered) list
  private all_users_list: any[] = []; // master list from API (unfiltered)

  // Exclusions
  private excludedIds = new Set<number>(); // owner + shared users

  // Form/search state
  searchQuery = '';
  selected_layer_id: any;
  selected_layer_users: any = [];
  user_add = false;

  // Selected user ids to submit (strings as per your API)
  selectedUsers: string[] = [];

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: any,
    public dialogRef: MatDialogRef<ShareLayerComponent>,
    private apiService: APIsService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
  ) {
    this.selectedUsers = this.data?.group_name ?? [];
    this.selected_layer_id = this.data?.layer_id;
  }

  ngOnInit(): void {
    const ownerId = Number(this.data?.owner?.id);
    const shared = Array.isArray(this.data?.shared_users) ? this.data.shared_users : [];
    this.excludedIds = new Set<number>([
      ...(ownerId ? [ownerId] : []),
      ...shared.map((u: any) => Number(u.id)),
    ]);

    this.getUsersList();
  }

  getUsersList() {
    this.apiService.getAdminUsers().subscribe(
      (res: any) => {
        this.all_users_list = (res || []).map((u: any) => ({ ...u, check_status: false }));
        this.applyUserFilters();

        this.cdr.markForCheck();
      },
      (err) => {
        console.error('getAdminUsers failed', err);
        this.notificationService.showError('Failed to load users');
      },
    );
  }

  /**
   * Only consider users with user_type === 'user'.
   * Then apply exclusion (owner + shared), search, and sort.
   */
  applyUserFilters() {
    const query = this.searchQuery.trim().toLowerCase();

    const onlyUsers = this.all_users_list.filter(
      (u: any) => (u?.user_type || '').toLowerCase() === 'user',
    );

    const afterExclude = onlyUsers.filter((u: any) => !this.excludedIds.has(Number(u?.id)));

    const afterSearch = !query
      ? afterExclude
      : afterExclude.filter((user: any) =>
          [
            user?.username,
            user?.email,
            user?.first_name,
            user?.last_name,
            user?.mobile,
            user?.department,
          ].some((field: any) => field?.toString().toLowerCase().includes(query)),
        );

    this.users_list = afterSearch.sort((a: any, b: any) =>
      (a?.department || '').localeCompare(b?.department || ''),
    );
  }

  /**
   * Toggle selections; store ids as strings.
   */
  toggleUserSelection(userId: number | null | undefined, isChecked: boolean) {
    this.user_add = true;
    const idStr = String(userId);
    if (isChecked) {
      if (!this.selectedUsers.includes(idStr)) this.selectedUsers.push(idStr);
    } else {
      this.selectedUsers = this.selectedUsers.filter((id) => id !== idStr);
    }
  }

  /**
   * Submit selected user ids (group_name) to backend.
   */
  SubmitAll() {
    const input_data = { group_name: this.selectedUsers };

    this.apiService.updateLayer(input_data, this.selected_layer_id).subscribe(
      (response: any) => {
        this.notificationService.showSuccess('Layer shared successfully');
        this.dialogRef.close(response);
      },
      (error: any) => {
        console.error('Error updating Layer:', error);
        this.notificationService.showError('Failed to update Layer');
      },
    );
  }

  closeDialog(): void {
    this.dialogRef.close();
  }
}
