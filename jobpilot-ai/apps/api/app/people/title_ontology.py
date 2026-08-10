from __future__ import annotations

import re
from dataclasses import dataclass

# v3: curated morphology (engineering≡engineer) plus a domain/role conflict
# guard. Both change which candidates are accepted, so results stored under v2
# are not comparable. This feeds SCORING_VERSION and therefore
# PEOPLE_SEARCH_CONTRACT_VERSION, which retires those runs rather than replaying
# them.
TITLE_ONTOLOGY_VERSION = "people-title-v3"

_PHRASE_EQUIVALENTS = {
    "artificial intelligence": "ai",
    "machine learning": "ml",
    "software development": "software engineering",
    "software developer": "software engineer",
    "talent acquisition": "recruiting",
    "talent partner": "recruiter",
    "campus": "early career",
    "university": "early career",
    "emerging talent": "early career",
    "new graduate": "early career",
    "new grad": "early career",
    "agentic ai": "applied ai",
    "ai platform": "applied ai",
}

_TOKEN_EQUIVALENTS = {
    "sr": "senior",
    "mgr": "manager",
    "dir": "director",
    "dev": "engineer",
    "developer": "engineer",
    "developers": "engineer",
    "engineers": "engineer",
    "recruiters": "recruiter",
    "managers": "manager",
    # Curated morphology, not a stemmer. A general stemmer collapses tokens that
    # mean different things in job titles ("analytics" is not "analyst"), so
    # only the discipline/role pairs that genuinely denote the same work are
    # listed, one at a time.
    #
    # The gap this closes: "Software Engineering" and "Software Engineer" shared
    # only one token, scoring 0.425 against a 0.42 floor — real employees were
    # discarded *after* their records had already been paid for.
    "engineering": "engineer",
    "recruiting": "recruiter",
    "recruitment": "recruiter",
    "management": "manager",
    "directors": "director",
    "analysts": "analyst",
    "scientists": "scientist",
    "architects": "architect",
    "designers": "designer",
    "specialists": "specialist",
    "partners": "partner",
    # Deliberately NOT mapped: "development" -> "engineer". "Business
    # Development" is a sales function, and collapsing it would make a Business
    # Development Manager match an Engineering Manager.
    # Also NOT mapped: "analytics" -> "analyst". A Data Analytics Engineer and a
    # Data Analyst are different jobs.
}

# Role nouns that appear in a large share of professional titles and therefore
# carry almost no matching signal on their own. "Civil Engineer" and "Software
# Engineer" overlap only here, as do "Product Manager" and "Product Engineer" —
# and before this guard every one of those pairs scored an identical 0.425,
# indistinguishable from a genuine match, and all of them cleared the referral
# floor. A shared head noun is not evidence of a shared role.
_GENERIC_ROLE_TOKENS = frozenset(
    {
        "engineer",
        "manager",
        "director",
        "analyst",
        "scientist",
        "recruiter",
        "specialist",
        "partner",
        "architect",
        "designer",
        "lead",
        "head",
        "senior",
        "junior",
        "staff",
        "principal",
        "associate",
        "intern",
        "consultant",
        "coordinator",
        "officer",
        "executive",
    }
)

_EARLY_CAREER_MARKERS = (
    "intern",
    "internship",
    "new grad",
    "new graduate",
    "graduate program",
    "early career",
    "entry level",
)

RECRUITER_CORE_TITLES = [
    "Recruiter",
    "Technical Recruiter",
    "Engineering Recruiter",
    "Software Recruiter",
    "AI Recruiter",
    "Technology Recruiter",
]
RECRUITER_BROAD_TITLES = [
    "Talent Acquisition",
    "Talent Acquisition Partner",
    "Talent Partner",
    "Senior Technical Recruiter",
    "Recruiting Manager",
    "University Recruiter",
    "Campus Recruiter",
    "Early Careers Recruiter",
]
RECRUITER_EARLY_CAREER_TITLES = [
    "University Recruiter",
    "Campus Recruiter",
    "Early Careers Recruiter",
    "University Talent Acquisition",
    "Emerging Talent Recruiter",
    "Campus Talent Partner",
    "University Programs Recruiter",
]

_MANAGER_TITLES = {
    "software_engineering": [
        "Software Engineering Manager",
        "Engineering Manager",
        "Senior Engineering Manager",
        "Software Development Manager",
        "Application Development Manager",
        "Technical Manager",
        "Director of Software Engineering",
        "Director of Engineering",
        "Head of Engineering",
        "Head of Software Engineering",
        "Engineering Lead",
    ],
    "machine_learning": [
        "AI Engineering Manager",
        "Machine Learning Engineering Manager",
        "Software Engineering Manager",
        "Engineering Manager",
        "Software Development Manager",
        "Applied AI Manager",
        "Director of AI",
        "Director of Software Engineering",
        "Director of Engineering",
        "Director of Machine Learning",
        "Head of Engineering",
        "Engineering Lead",
    ],
    "embedded_systems": [
        "Embedded Software Manager",
        "Firmware Engineering Manager",
        "Embedded Systems Manager",
        "Director of Embedded Engineering",
        "Director of Engineering",
    ],
    "product": [
        "Product Manager",
        "Group Product Manager",
        "Director of Product",
        "Head of Product",
        "VP of Product",
    ],
    "finance": [
        "Finance Manager",
        "Accounting Manager",
        "Director of Finance",
        "Head of Finance",
        "VP of Finance",
    ],
    "healthcare": [
        "Clinical Engineering Manager",
        "Healthcare Technology Manager",
        "Director of Clinical Engineering",
        "Director of Engineering",
    ],
}

_TEAM_TITLES = {
    "software_engineering": [
        "Software Engineer",
        "Software Developer",
        "Backend Engineer",
        "Frontend Engineer",
        "Full Stack Engineer",
        "Platform Engineer",
        "Application Engineer",
        "Systems Engineer",
        "Senior Software Engineer",
        "Staff Software Engineer",
        "Principal Software Engineer",
        "Technical Lead",
    ],
    "machine_learning": ["AI Engineer", "Machine Learning Engineer", "Applied Scientist"],
    "embedded_systems": [
        "Embedded Software Engineer",
        "Firmware Engineer",
        "Embedded Systems Engineer",
    ],
    "product": ["Product Manager", "Product Owner", "Product Analyst"],
    "finance": ["Financial Analyst", "Accountant", "Finance Business Partner"],
    "healthcare": ["Clinical Engineer", "Healthcare Systems Engineer", "Biomedical Engineer"],
}


@dataclass(frozen=True)
class TitleGroup:
    name: str
    titles: list[str]
    seniorities: list[str]


def normalize_title(value: str | None) -> str:
    normalized = re.sub(r"[^a-z0-9+]+", " ", (value or "").lower()).strip()
    for source, target in sorted(_PHRASE_EQUIVALENTS.items(), key=lambda item: -len(item[0])):
        normalized = re.sub(rf"\b{re.escape(source)}\b", target, normalized)
    tokens = [_TOKEN_EQUIVALENTS.get(token, token) for token in normalized.split()]
    return " ".join(tokens)


def title_similarity(value: str | None, choices: list[str]) -> float:
    left = set(normalize_title(value).split())
    if not left:
        return 0
    best = 0.0
    for choice in choices:
        right = set(normalize_title(choice).split())
        if not right:
            continue
        shared = left & right
        overlap = len(shared)
        containment = overlap / max(1, len(right))
        jaccard = overlap / max(1, len(left | right))
        score = 0.55 * containment + 0.45 * jaccard
        # A professional title is a domain qualifier plus a role noun ("civil"
        # + "engineer"). Two titles are only similar when neither part
        # *conflicts*. Before this guard, "Civil Engineer" vs "Software
        # Engineer", "Product Manager" vs "Product Engineer" and "Data
        # Engineer" vs "Data Analyst" all scored an identical 0.425 — the same
        # score as a genuine match, and all above the referral floor.
        left_roles, right_roles = left & _GENERIC_ROLE_TOKENS, right & _GENERIC_ROLE_TOKENS
        left_domain, right_domain = left - _GENERIC_ROLE_TOKENS, right - _GENERIC_ROLE_TOKENS
        conflicting_domain = bool(left_domain and right_domain and not (left_domain & right_domain))
        conflicting_role = bool(left_roles and right_roles and not (left_roles & right_roles))
        if conflicting_domain or conflicting_role:
            # Damped, not zeroed: a weak signal stays weak rather than becoming
            # a hard exclusion that a later relaxation tier cannot recover.
            score *= 0.5
        best = max(best, score)
    return round(min(1.0, best), 4)


def is_early_career_job(title: str, description: str = "") -> bool:
    haystack = f"{title} {description[:2000]}".lower()
    return any(marker in haystack for marker in _EARLY_CAREER_MARKERS)


def recruiter_title_groups(*, early_career: bool) -> list[TitleGroup]:
    groups = [
        TitleGroup("specialist", RECRUITER_CORE_TITLES, []),
        TitleGroup("broad", RECRUITER_BROAD_TITLES, []),
    ]
    if early_career:
        groups.append(TitleGroup("early_career", RECRUITER_EARLY_CAREER_TITLES, []))
    return groups


def manager_title_groups(role_family: str | None, base_title: str) -> list[TitleGroup]:
    titles = _MANAGER_TITLES.get(
        role_family or "",
        [f"{base_title} Manager", "Department Manager", "Director", "Head"],
    )
    managers = [title for title in titles if "manager" in normalize_title(title).split()]
    leadership = [title for title in titles if title not in managers]
    return [
        TitleGroup("manager", managers or titles[:2], ["manager"]),
        TitleGroup(
            "leadership",
            leadership or titles[-2:],
            ["director", "head", "vp"],
        ),
    ]


def team_titles(role_family: str | None, job_title: str) -> list[str]:
    configured = _TEAM_TITLES.get(role_family or "", [])
    return list(dict.fromkeys([job_title, *configured]))
