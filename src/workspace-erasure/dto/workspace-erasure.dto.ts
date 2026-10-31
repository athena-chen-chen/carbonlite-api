import { Equals, IsBoolean, IsString, MinLength } from 'class-validator';

export class WorkspaceErasureDryRunDto {
  @IsString()
  @MinLength(1)
  organizationId!: string;
}

export class EraseWorkspaceDto extends WorkspaceErasureDryRunDto {
  @IsString()
  @MinLength(1)
  confirmationOrganizationId!: string;

  @IsString()
  @MinLength(1)
  confirmationOrganizationSlug!: string;

  @IsBoolean()
  @Equals(true)
  confirmErase!: true;
}
