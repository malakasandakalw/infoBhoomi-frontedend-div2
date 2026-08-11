/**
 *@KD-96
 */
import {
  Component,
  Input,
  OnInit,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PermissionService } from '../../../services/permissions.service';
import { DataService } from '../../../services/data.service';
import { LandTabPermissions } from '../../../core/PermissionIds';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-key-value-dropdown',
  imports: [CommonModule, FormsModule],
  templateUrl: './key-value-dropdown.component.html',
  styleUrl: './key-value-dropdown.component.css',
})
export class KeyValueDropdownComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  @Input() key!: string;
  @Input() db_tag!: string; // use when generate payload
  @Input() value!: string | number;
  @Input() permissionKey!: string;
  @Input() ddListID!: string;
  @Input() hardcodedList: string[] = []; // if avilabel - optional

  @Output() valueChange = new EventEmitter<{
    db_tag: string;
    value: string | number;
  }>();

  roleId = 1;
  permissions: any = {};
  options: { id: string; name: string }[] = []; // Array to hold dropdown options

  constructor(
    private permissionService: PermissionService,
    private dataService: DataService, // To fetch dropdown options
  ) {}

  async ngOnInit(): Promise<void> {
    // Load permissions
    const cachedData = sessionStorage.getItem(`k-v_perm_dd_${this.roleId}`);
    if (cachedData) {
      this.permissions = JSON.parse(cachedData);
    } else {
      const permissionMap = await this.permissionService
        .loadPermissions(this.roleId, [
          ...LandTabPermissions.L_ADMIN_INFO,
          ...LandTabPermissions.L_LAND_OVERVIEW,
          ...LandTabPermissions.L_UTILITY_INFO,
        ])
        .toPromise();
      this.permissions = permissionMap;

      console.log(permissionMap);

      sessionStorage.setItem(`k-v_perm_dd_${this.roleId}`, JSON.stringify(this.permissions));
    }

    // Fetch dropdown options from API
    this.loadDropdownOptions();
  }

  loadDropdownOptions(): void {
    // console.log('dd loading');

    if (this.ddListID) {
      this.dataService.getDropdownOptions(this.ddListID).subscribe(
        (data) => {
          this.options = data;

          // Ensure the initial value matches one of the options
          const matchedOption = this.options.find(
            (option) => String(option.name) === String(this.value),
          );

          if (matchedOption) {
            this.value = matchedOption.id; // Set the matching option's ID as the value
            this.onValueChange(this.value); // Emit the change to keep the parent in sync
            console.log('dropdown loaded');
          } else {
            this.value = ''; // Set empty if no matching option is found
            this.onValueChange(this.value); // Emit the change to keep the parent in sync
          }

          this.cdr.markForCheck();
        },
        (error) => {
          console.error('Error fetching dropdown options:', error);
        },
      );
    } else {
      // Use hardcoded list only if no ddListID is provided
      this.options = this.hardcodedList.map((item) => ({
        id: item,
        name: item,
      }));
    }
  }

  onValueChange(newValue: string | number): void {
    const selectedOption = this.options.find((option) => String(option.id) === String(newValue));
    if (selectedOption) {
      this.valueChange.emit({
        db_tag: this.db_tag,
        value: selectedOption.name,
      });
    } else {
      this.valueChange.emit({ db_tag: this.db_tag, value: newValue }); // Fallback
    }
  }

  get editable(): boolean {
    const perms = this.permissions?.[this.permissionKey];
    return (this.value && perms?.can_edit) || (perms?.can_add && perms?.can_edit);
  }

  get hidden(): boolean {
    return !this.permissions?.[this.permissionKey]?.can_view;
  }
}
