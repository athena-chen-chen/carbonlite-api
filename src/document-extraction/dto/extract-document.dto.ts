import { IsString } from 'class-validator';

export class ExtractDocumentDto {
  @IsString()
  documentId!: string;
}