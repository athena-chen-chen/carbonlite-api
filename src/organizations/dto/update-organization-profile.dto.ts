import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const INDUSTRY_OPTIONS = [
  'Agriculture',
  'Construction',
  'Energy / Utilities',
  'Financial Services',
  'Food & Beverage',
  'Healthcare',
  'Hospitality',
  'Manufacturing',
  'Professional Services',
  'Real Estate',
  'Retail',
  'Technology',
  'Transportation / Logistics',
  'Other',
] as const;

export const CANADA_PROVINCE_TERRITORY_OPTIONS = [
  'Alberta',
  'British Columbia',
  'Manitoba',
  'New Brunswick',
  'Newfoundland and Labrador',
  'Northwest Territories',
  'Nova Scotia',
  'Nunavut',
  'Ontario',
  'Prince Edward Island',
  'Quebec',
  'Saskatchewan',
  'Yukon',
] as const;

const REQUIRED_MESSAGE = '$property is required.';
export const EMAIL_MESSAGE = 'Please enter a valid email address.';

export class UpdateOrganizationProfileDto {
  @IsString()
  @MaxLength(1200)
  organizationName!: string;

  @IsString()
  @IsIn(INDUSTRY_OPTIONS, { message: 'Please select an industry.' })
  industry!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  otherIndustry?: string;

  @IsString()
  @IsIn(['Canada'], {
    message: 'Country must be Canada for the current pilot version.',
  })
  country!: string;

  @IsString()
  @IsIn(CANADA_PROVINCE_TERRITORY_OPTIONS, {
    message: 'Please select a province or territory.',
  })
  provinceOrState!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  primaryContactName?: string;

  @ValidateIf((dto) => Boolean(String(dto.primaryContactEmail ?? '').trim()))
  @IsEmail({}, { message: EMAIL_MESSAGE })
  @MaxLength(1200)
  primaryContactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  reportingPeriodStart?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  reportingPeriodEnd?: string;

  @IsOptional()
  @IsString({ message: REQUIRED_MESSAGE })
  @MaxLength(1200)
  geographicBoundary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  includedFacilitiesOrLocations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  excludedFacilitiesOrLocations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  includedScopes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  scope3CoverageNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  exclusionsAndLimitations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  boundaryNotes?: string;
}
