/**
 * Static catalogs the profile editors offer as suggestions: work-authorization
 * options, the role/level/location pickers, and per-role skill hints.
 *
 * These are SUGGESTIONS, never a whitelist. A user's own custom role, location,
 * or skill is always preserved — nothing in the editors filters a stored value
 * out because it is absent from these lists.
 *
 * Kept in a plain module (no "use client") so both the wizard and the focused
 * editors read one definition, and a server component could too. Every export
 * of a client module becomes a client *reference* when a server component
 * imports it, which silently yields `undefined`.
 */

export const workAuthorizationOptions = [
  ["authorized_us", "Authorized to work in the United States"],
  ["authorized_other_country", "Authorized to work in another country"],
  ["need_sponsorship_now", "Need sponsorship now"],
  ["need_sponsorship_future", "Need sponsorship in the future"],
  ["student_visa", "Student visa / OPT / CPT"],
  ["opt_cpt", "OPT / CPT"],
  ["not_authorized", "Not currently authorized"],
  ["prefer_not_to_say", "Prefer not to say"],
  ["other", "Other"]
] as const;

export const roleGroups = [
  {
    label: "Software & Engineering",
    options: [
      "Software Engineer",
      "Backend Engineer",
      "Frontend Engineer",
      "Full Stack Engineer",
      "Mobile Developer",
      "iOS Developer",
      "Android Developer",
      "DevOps Engineer",
      "Site Reliability Engineer",
      "Cloud Engineer",
      "Platform Engineer",
      "QA Engineer",
      "Automation Engineer",
      "Security Engineer",
      "Embedded Software Engineer",
      "Firmware Engineer",
      "Systems Engineer"
    ]
  },
  {
    label: "AI/Data",
    options: [
      "AI Engineer",
      "Machine Learning Engineer",
      "MLOps Engineer",
      "Data Scientist",
      "Data Analyst",
      "Data Engineer",
      "Business Intelligence Analyst",
      "Research Engineer",
      "NLP Engineer",
      "Computer Vision Engineer",
      "Applied Scientist"
    ]
  },
  {
    label: "Product/Design",
    options: [
      "Product Manager",
      "Associate Product Manager",
      "Product Analyst",
      "UX Designer",
      "UI Designer",
      "UX Researcher"
    ]
  },
  {
    label: "Business/Operations",
    options: [
      "Business Analyst",
      "Operations Analyst",
      "Strategy Analyst",
      "Project Coordinator",
      "Program Manager",
      "Technical Program Manager",
      "Customer Success Manager",
      "Sales Development Representative",
      "Marketing Analyst",
      "Growth Analyst"
    ]
  },
  {
    label: "Mechanical/Hardware",
    options: [
      "Mechanical Engineer",
      "Manufacturing Engineer",
      "Industrial Engineer",
      "Electrical Engineer",
      "Hardware Engineer",
      "Robotics Engineer",
      "CAD Designer"
    ]
  }
];

export const targetLevelOptions = [
  "Internship",
  "Co-op",
  "New Grad",
  "Entry Level",
  "Junior",
  "Associate",
  "Mid Level",
  "Senior",
  "Staff",
  "Principal",
  "Manager",
  "Director",
  "0-1 years",
  "1-3 years",
  "3-5 years",
  "5-10 years",
  "10+ years"
];

export const locationQuickOptions = [
  "Remote",
  "United States",
  "Phoenix, AZ",
  "Tempe, AZ",
  "San Francisco, CA",
  "San Jose, CA",
  "Seattle, WA",
  "New York, NY",
  "Austin, TX",
  "Dallas, TX",
  "Chicago, IL",
  "Boston, MA",
  "Atlanta, GA",
  "Los Angeles, CA",
  "Washington, DC"
];

export const skillSuggestions: Record<string, string[]> = {
  "Software Engineer": ["Python", "JavaScript", "TypeScript", "React", "Node.js", "SQL", "Git"],
  "Backend Engineer": ["Python", "FastAPI", "Django", "Flask", "PostgreSQL", "Redis", "Docker"],
  "AI Engineer": ["Python", "PyTorch", "TensorFlow", "LangChain", "OpenAI API", "RAG", "Vector Databases"],
  "Data Analyst": ["SQL", "Excel", "Tableau", "Power BI", "Python", "Pandas"]
};
