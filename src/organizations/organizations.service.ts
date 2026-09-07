import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CANADA_PROVINCE_TERRITORY_OPTIONS,
  EMAIL_MESSAGE,
  INDUSTRY_OPTIONS,
  UpdateOrganizationProfileDto,
} from './dto/update-organization-profile.dto';

export type OrganizationProfileResponse = {
  organizationName: string;
  industry: string;
  otherIndustry: string;
  country: string;
  provinceOrState: string;
  city: string;
  primaryContactName: string;
  primaryContactEmail: string;
  reportingPeriodStart: string;
  reportingPeriodEnd: string;
  geographicBoundary: string;
  includedFacilitiesOrLocations: string;
  excludedFacilitiesOrLocations: string;
  includedScopes: string;
  scope3CoverageNote: string;
  exclusionsAndLimitations: string;
  boundaryNotes: string;
};

const SAMPLE_WORKSPACE_NAME = 'CarbonLite Sample Workspace';
const SAMPLE_WORKSPACE_DEFAULTS: OrganizationProfileResponse = {
  organizationName: SAMPLE_WORKSPACE_NAME,
  industry: 'Technology',
  otherIndustry: '',
  country: 'Canada',
  provinceOrState: 'Alberta',
  city: 'Calgary',
  primaryContactName: '',
  primaryContactEmail: '',
  reportingPeriodStart: '2026-01-01',
  reportingPeriodEnd: '2026-12-31',
  geographicBoundary:
    'Sample Canadian operations, including Alberta, British Columbia, and Ontario activity records',
  includedFacilitiesOrLocations:
    'Sample facilities or activity locations represented in the pilot dataset',
  excludedFacilitiesOrLocations: '',
  includedScopes: 'Scope 1, Scope 2, and selected Scope 3 pilot activity types',
  scope3CoverageNote:
    'Current pilot Scope 3 coverage focuses on selected business travel and transportation-related activity records.',
  exclusionsAndLimitations:
    'This sample inventory is for workflow review only and does not represent a certified or complete organizational GHG inventory.',
  boundaryNotes:
    'Current pilot supports selected units and activity types. Additional unit conversion and Scope 3 categories may be added in future versions.',
};

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrganizationProfile(user: AuthenticatedUser) {
    const organization = await this.prisma.organization.findFirst({
      where: {
        id: user.organizationId,
        isActive: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Workspace profile was not found.');
    }

    return this.toProfileResponse(organization);
  }

  async updateOrganizationProfile(
    user: AuthenticatedUser,
    dto: UpdateOrganizationProfileDto,
  ) {
    if (user.accountType === 'PILOT_REVIEWER' || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'This account is read-only for pilot review. Editing actions are disabled.',
      );
    }

    const profile = this.normalizeAndValidate(dto);

    const organization = await this.prisma.organization.update({
      where: { id: user.organizationId },
      data: {
        name: profile.organizationName,
        industry: profile.industry,
        otherIndustry: profile.otherIndustry || null,
        country: profile.country,
        provinceState: profile.provinceOrState,
        city: profile.city || null,
        primaryContactName: profile.primaryContactName || null,
        primaryContactEmail: profile.primaryContactEmail || null,
        reportingPeriodStart: profile.reportingPeriodStart || null,
        reportingPeriodEnd: profile.reportingPeriodEnd || null,
        geographicBoundary: profile.geographicBoundary || null,
        includedFacilitiesOrLocations:
          profile.includedFacilitiesOrLocations || null,
        excludedFacilitiesOrLocations:
          profile.excludedFacilitiesOrLocations || null,
        includedScopes: profile.includedScopes || null,
        scope3CoverageNote: profile.scope3CoverageNote || null,
        exclusionsAndLimitations: profile.exclusionsAndLimitations || null,
        boundaryNotes: profile.boundaryNotes || null,
      },
    });

    return this.toProfileResponse(organization);
  }

  private toProfileResponse(organization: {
    name: string;
    industry: string | null;
    otherIndustry: string | null;
    country: string | null;
    provinceState: string | null;
    city: string | null;
    primaryContactName: string | null;
    primaryContactEmail: string | null;
    reportingPeriodStart: string | null;
    reportingPeriodEnd: string | null;
    geographicBoundary: string | null;
    includedFacilitiesOrLocations: string | null;
    excludedFacilitiesOrLocations: string | null;
    includedScopes: string | null;
    scope3CoverageNote: string | null;
    exclusionsAndLimitations: string | null;
    boundaryNotes: string | null;
  }): OrganizationProfileResponse {
    const defaults =
      organization.name === SAMPLE_WORKSPACE_NAME
        ? SAMPLE_WORKSPACE_DEFAULTS
        : {
            ...SAMPLE_WORKSPACE_DEFAULTS,
            organizationName: organization.name,
            industry: '',
            provinceOrState: '',
            city: '',
            excludedFacilitiesOrLocations: '',
          };

    return {
      organizationName: clean(organization.name) || defaults.organizationName,
      industry: clean(organization.industry) || defaults.industry,
      otherIndustry: clean(organization.otherIndustry),
      country: clean(organization.country) || defaults.country,
      provinceOrState:
        clean(organization.provinceState) || defaults.provinceOrState,
      city: clean(organization.city) || defaults.city,
      primaryContactName: clean(organization.primaryContactName),
      primaryContactEmail: clean(organization.primaryContactEmail).toLowerCase(),
      reportingPeriodStart:
        clean(organization.reportingPeriodStart) ||
        defaults.reportingPeriodStart,
      reportingPeriodEnd:
        clean(organization.reportingPeriodEnd) || defaults.reportingPeriodEnd,
      geographicBoundary:
        clean(organization.geographicBoundary) || defaults.geographicBoundary,
      includedFacilitiesOrLocations:
        clean(organization.includedFacilitiesOrLocations) ||
        defaults.includedFacilitiesOrLocations,
      excludedFacilitiesOrLocations:
        clean(organization.excludedFacilitiesOrLocations) ||
        defaults.excludedFacilitiesOrLocations,
      includedScopes: clean(organization.includedScopes) || defaults.includedScopes,
      scope3CoverageNote:
        clean(organization.scope3CoverageNote) || defaults.scope3CoverageNote,
      exclusionsAndLimitations:
        clean(organization.exclusionsAndLimitations) ||
        defaults.exclusionsAndLimitations,
      boundaryNotes: clean(organization.boundaryNotes) || defaults.boundaryNotes,
    };
  }

  private normalizeAndValidate(dto: UpdateOrganizationProfileDto) {
    const profile: OrganizationProfileResponse = {
      organizationName: clean(dto.organizationName),
      industry: clean(dto.industry),
      otherIndustry: clean(dto.otherIndustry),
      country: 'Canada',
      provinceOrState: clean(dto.provinceOrState),
      city: clean(dto.city),
      primaryContactName: clean(dto.primaryContactName),
      primaryContactEmail: clean(dto.primaryContactEmail).toLowerCase(),
      reportingPeriodStart: clean(dto.reportingPeriodStart),
      reportingPeriodEnd: clean(dto.reportingPeriodEnd),
      geographicBoundary: clean(dto.geographicBoundary),
      includedFacilitiesOrLocations: clean(dto.includedFacilitiesOrLocations),
      excludedFacilitiesOrLocations: clean(dto.excludedFacilitiesOrLocations),
      includedScopes: clean(dto.includedScopes),
      scope3CoverageNote: clean(dto.scope3CoverageNote),
      exclusionsAndLimitations: clean(dto.exclusionsAndLimitations),
      boundaryNotes: clean(dto.boundaryNotes),
    };

    if (!profile.organizationName) {
      throw new BadRequestException('Organization / Workspace is required.');
    }
    if (!(INDUSTRY_OPTIONS as readonly string[]).includes(profile.industry)) {
      throw new BadRequestException('Please select an industry.');
    }
    if (profile.industry === 'Other' && !profile.otherIndustry) {
      throw new BadRequestException('Please enter an industry.');
    }
    if (
      !(CANADA_PROVINCE_TERRITORY_OPTIONS as readonly string[]).includes(
        profile.provinceOrState,
      )
    ) {
      throw new BadRequestException('Please select a province or territory.');
    }
    if (
      profile.primaryContactEmail &&
      !isValidPrimaryContactEmail(profile.primaryContactEmail)
    ) {
      throw new BadRequestException(EMAIL_MESSAGE);
    }
    if (
      profile.reportingPeriodStart &&
      !/^\d{4}-\d{2}-\d{2}$/.test(profile.reportingPeriodStart)
    ) {
      throw new BadRequestException('Please enter valid reporting period dates.');
    }
    if (
      profile.reportingPeriodEnd &&
      !/^\d{4}-\d{2}-\d{2}$/.test(profile.reportingPeriodEnd)
    ) {
      throw new BadRequestException('Please enter valid reporting period dates.');
    }
    if (
      profile.reportingPeriodStart &&
      profile.reportingPeriodEnd &&
      profile.reportingPeriodEnd <= profile.reportingPeriodStart
    ) {
      throw new BadRequestException(
        'Reporting Period End must be after Reporting Period Start.',
      );
    }

    return profile;
  }
}

function clean(value?: string | null) {
  return String(value ?? '').trim();
}

function isValidPrimaryContactEmail(email: string) {
  const normalized = clean(email).toLowerCase();
  if (!normalized) return true;
  if (/[\s[\]()]|mailto:/i.test(normalized)) return false;

  const parts = normalized.split('@');
  if (parts.length !== 2) return false;

  const [localPart, domain] = parts;
  if (!localPart || !domain || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.split('.').some((part) => !part)) return false;

  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(
    normalized,
  );
}
