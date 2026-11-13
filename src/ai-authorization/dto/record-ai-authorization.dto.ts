import {
  IsDateString,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AI_PROVIDER_OPENAI,
  AI_SCOPE_DOCUMENT_EXTRACTION,
} from '../ai-authorization.constants';

export class RecordAiAuthorizationDto {
  @IsIn(['DISABLED', 'ENABLED'])
  status!: 'DISABLED' | 'ENABLED';

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  consentVersion!: string;

  @IsIn([AI_PROVIDER_OPENAI])
  provider!: typeof AI_PROVIDER_OPENAI;

  @IsIn([AI_SCOPE_DOCUMENT_EXTRACTION])
  processingScope!: typeof AI_SCOPE_DOCUMENT_EXTRACTION;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  evidenceReference!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  authorizedRepresentativeReference!: string;

  @IsDateString()
  effectiveAt!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsIn(['SYNTHETIC_TEST_ONLY', 'REAL_CUSTOMER_DATA'])
  authorizedDataMode?: 'SYNTHETIC_TEST_ONLY' | 'REAL_CUSTOMER_DATA';

  @IsOptional()
  @IsInt()
  @Min(1)
  realDataApprovalRevision?: number;
}
