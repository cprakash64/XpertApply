from datetime import datetime

from pydantic import BaseModel, Field


class DiscoverJobsIn(BaseModel):
    posted_within_days: int = Field(default=7, ge=1, le=60)
    include_unknown_dates: bool = False
    include_unknown_location: bool = False


class GenerateMaterialsIn(BaseModel):
    types: list[str] = Field(default_factory=lambda: ["resume", "cover_letter"])


class DocumentUpdateIn(BaseModel):
    markdown: str | None = None
    plain_text: str | None = None
    content: dict | None = None
    title: str | None = None


class JobMatchInfo(BaseModel):
    fit_score: float | None = None
    fit_label: str | None = None
    match_reasons: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    risk_factors: list[str] = Field(default_factory=list)
    recommended_resume_angle: str | None = None
    confidence: float | None = None
    explanation_source: str | None = None


class JobCardOut(BaseModel):
    id: int
    title: str
    company: str
    source: str | None = None
    location: str | None = None
    workplace_type: str | None = None
    employment_type: str | None = None
    seniority_level: str | None = None
    posted_at: datetime | None = None
    discovered_at: datetime
    application_url: str
    source_url: str
    description_clean: str = ""
    required_skills: list[str] = Field(default_factory=list)
    preferred_skills: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None
    match: JobMatchInfo | None = None


class JobPostingOut(BaseModel):
    id: int
    title: str
    company: str
    location: str | None = None
    remote_type: str | None = None
    employment_type: str | None = None
    seniority_level: str | None = None
    posted_at: datetime | None = None
    discovered_at: datetime
    application_url: str
    source_url: str
    description_clean: str
    required_skills: list[str] = Field(default_factory=list)
    preferred_skills: list[str] = Field(default_factory=list)
    fit_score: float | None = None
    fit_summary: str | None = None


class JobMatchOut(BaseModel):
    job_id: int
    fit_score: float
    fit_summary: str
    strengths: list[str]
    gaps: list[str]
    risks: list[str]
    recommended_resume_angle: str | None = None


class GeneratedDocumentOut(BaseModel):
    id: int
    job_id: int
    type: str
    format: str
    content: dict
    file_path: str | None = None
    created_at: datetime


class ApplicationTrackerIn(BaseModel):
    status: str
    notes: str | None = None
    follow_up_date: str | None = None


class ApplicationTrackerOut(BaseModel):
    id: int
    job_id: int
    status: str
    notes: str | None = None
    applied_at: datetime | None = None
    deletion_scheduled_at: datetime | None = None
    confirmation_required_at: datetime | None = None
    confirmation_prompt_dismissed_at: datetime | None = None
    snapshot_available: bool = False
    snapshot_count: int = 0


class SnapshotArtifactResponse(BaseModel):
    document_id: int | None = None
    filename: str | None = None
    content_hash: str | None = Field(default=None, min_length=64, max_length=64)


class SnapshotAnswerResponse(BaseModel):
    canonical_key: str = Field(max_length=120)
    display_value: str = Field(max_length=4000)
    source: str | None = Field(default=None, max_length=60)
    requires_review: bool = False


class ApplicationSnapshotResponse(BaseModel):
    id: int
    application_tracker_id: int
    attempt_number: int
    confirmation_source: str
    submission_evidence_type: str | None = None
    ats_provider: str | None = None
    job_external_id: str | None = None
    job_title: str
    company_name: str
    job_url: str | None = None
    source_url: str | None = None
    job_description_snapshot: str | None = None
    resume: SnapshotArtifactResponse
    cover_letter_used: bool
    cover_letter: SnapshotArtifactResponse
    cover_letter_text_snapshot: str | None = None
    answers: list[SnapshotAnswerResponse] = Field(default_factory=list)
    applied_at: datetime
    created_at: datetime
