import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { FACTOR_APPLICABILITIES, EMISSION_BASES, FactorApplicability, EmissionBasis } from '../factor-governance';
export class MethodologyProvenanceDto {
 @IsOptional() @IsString() @MaxLength(500)
 methodologyDocument?: string;
 @IsOptional() @IsString() @MaxLength(500)
 methodologyVersion?: string;
 @IsOptional() @IsString() @MaxLength(500)
 methodologyMethod?: string;
 @IsOptional() @IsString() @MaxLength(500)
 methodologySection?: string;
 @IsOptional() @IsString() @MaxLength(500)
 methodologyLevel?: string;
 @IsOptional() @IsString() @MaxLength(500)
 gwpSource?: string;
 @IsOptional() @IsString() @MaxLength(500)
 gwpVersion?: string;
 @IsOptional() @IsString() @MaxLength(500)
 sourceVersion?: string;
 @IsOptional() @IsISO8601() publishedDate?: string;
 @IsOptional() @IsInt() @Min(1900) @Max(2100) factorYear?: number;
 @IsOptional() @IsString() @MaxLength(100) factorVersion?: string;
 @IsOptional() @IsString() @MaxLength(500) sourceTable?: string;
 @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(150, { each: true }) sectorApplicability?: string[];
 @IsOptional() @IsIn(['ENERGY_HHV', 'VOLUME']) quantityBasis?: 'ENERGY_HHV' | 'VOLUME';
}
export class FactorGovernanceDto {
 @IsOptional() @IsIn(FACTOR_APPLICABILITIES) applicability?: FactorApplicability | null;
 @IsOptional() @IsIn(EMISSION_BASES) emissionBasis?: EmissionBasis | null;
 @IsOptional() @ValidateNested() @Type(() => MethodologyProvenanceDto) methodologyProvenance?: MethodologyProvenanceDto | null;
}
