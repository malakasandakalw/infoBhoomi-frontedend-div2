import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { Token } from '../../../core/constant';
import { APIsService } from '../../../services/api.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-panel-img',
  standalone: true,
  imports: [MatIcon, CommonModule],
  templateUrl: './panel-img.component.html',
  styleUrls: ['./panel-img.component.css'], // Fixed styleUrls typo
})
export class PanelImgComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  @Input() suId!: number; // Unique ID for the image
  @Input() placeholder!: string; // Default placeholder image
  @Output() imageChange = new EventEmitter<File>(); // Emit selected image to parent
  @Input() allowUpload: boolean = false; // <-- Make sure this @Input exists

  imageUrl: string | null = null; // Image URL to display
  loading: boolean = false; // Loader flag

  constructor(
    private http: HttpClient,
    private apiService: APIsService, // Service for API calls
  ) {}

  ngOnInit(): void {
    this.loadImage();
    console.log(Token.TOKEN); // Debugging token
  }

  // Fetch the image from the backend using Token.TOKEN
  loadImage(): void {
    const headers = new HttpHeaders({
      Authorization: `Token ${Token.TOKEN}`, // Add token to headers
    });

    this.loading = true;
    this.http
      .get(this.apiService.SIDE_PANEL_IMG(`${this.suId}`), {
        headers,
        responseType: 'blob',
      })
      .subscribe({
        next: (blob: Blob) => {
          const objectUrl = URL.createObjectURL(blob);
          this.imageUrl = objectUrl;
          this.loading = false;

          this.cdr.markForCheck();
        },
        error: () => {
          console.log('Error loading image');

          // Use placeholder if image retrieval fails
          this.imageUrl = `img/placeholders/${this.placeholder}`;
          this.loading = false;
        },
      });
  }

  // Handle file selection and emit event for upload
  onFileSelected(event: any): void {
    const file: File = event.target.files[0];
    if (file) {
      this.imageChange.emit(file); // Emit selected file
      const reader = new FileReader();
      reader.onload = () => {
        this.imageUrl = reader.result as string; // Update preview
      };
      reader.readAsDataURL(file);
    }
  }
}
