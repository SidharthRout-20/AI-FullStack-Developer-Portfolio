/**
 * Everything personal on the portfolio lives here: edit this file, not the components.
 * Content is taken from the resume in /documents. Empty strings are hidden automatically.
 */
export const SITE = {
  owner: "Sidharth Rout",
  role: "AI Full-Stack Developer",
  current: "Consultant at Deloitte",
  location: "New Delhi, India",
  /** Put a square photo at frontend/public/avatar.jpg and set '/avatar.jpg'. Empty → initials monogram. */
  avatar: "",
  headline: "I build AI products, from the model to the last pixel.",
  intro:
    "5+ years shipping software for global clients: I started on COBOL, grew into a senior React UI/UX developer, and today " +
    "build Generative-AI proofs of concept at Deloitte. This site is my product lab: seven working AI apps, built end " +
    "to end with React 19 and Python.",
  links: {
    github: "https://github.com/SidharthRout-20",
    linkedin: "https://www.linkedin.com/in/sidharth-rout-072696119/",
    email: "sidharthrout42@gmail.com",
  },
} as const;

export interface Expertise {
  title: string;
  icon: "ui" | "ai" | "api";
  text: string;
  stack: string[];
}

export const EXPERTISE: Expertise[] = [
  {
    title: "Frontend & UI engineering",
    icon: "ui",
    text:
      "Senior UI/UX developer for enterprise clients: apps built from wireframes, design systems in Material-UI, " +
      "skeleton and lazy loading, responsive landing pages, CMS migrations.",
    stack: [
      "React",
      "Redux / RTK",
      "TypeScript",
      "JavaScript",
      "HTML",
      "CSS",
      "Tailwind CSS",
      "Material-UI",
      "Figma",
      "Adobe XD",
      "ContentStack",
    ],
  },
  {
    title: "Generative AI & agents",
    icon: "ai",
    text:
      "GenAI proofs of concept at Deloitte, and seven AI products on this site: RAG with citations, tool-using agents, " +
      "structured outputs, speech and vision.",
    stack: [
      "RAG",
      "LangGraph",
      "Agents & tools",
      "Prompt engineering",
      "Claude",
      "Groq",
      "Whisper",
      "FastEmbed",
      "ChromaDB",
    ],
  },
  {
    title: "APIs, data & delivery",
    icon: "api",
    text:
      "Python services and API integrations alongside backend teams, delivered with Agile tooling. Started my career on " +
      "COBOL mainframe systems for a US insurer.",
    stack: [
      "Python",
      "Flask",
      "FastAPI",
      "REST APIs",
      "MySQL",
      "MongoDB",
      "Docker",
      "Git / GitLab",
      "Postman",
      "Jira",
      "COBOL",
    ],
  },
];

export interface TimelineItem {
  period: string;
  title: string;
  org: string;
  place: string;
  kind: "work" | "education";
  points: string[];
  tags: string[];
}

export const TIMELINE: TimelineItem[] = [
  {
    period: "Dec 2023 – Present",
    title: "Consultant",
    org: "Deloitte",
    place: "Gurgaon, India",
    kind: "work",
    points: [
      "Develop and integrate proofs of concept for new solutions built with Generative AI.",
      "Deliver client solutions with cross-functional teams under tight deadlines.",
      "Design UX wireframes in Figma.",
    ],
    tags: ["Generative AI", "React", "Python", "Figma"],
  },
  {
    period: "Apr 2022 – Sep 2023",
    title: "Senior Software Engineer",
    org: "Wipro · clients HP and Telefonica",
    place: "Bengaluru, India",
    kind: "work",
    points: [
      "Built a web application from scratch from client wireframes with Material-UI, owning the API integrations with the backend team.",
      "Delivered a new landing page with skeleton loading, lazy loading and mobile responsiveness.",
      "Led CMS integrations during a ContentStack migration and modernised legacy code bases.",
    ],
    tags: ["React", "Redux Toolkit", "Material-UI", "ContentStack", "Adobe XD"],
  },
  {
    period: "May 2019 – Mar 2022",
    title: "Project Engineer",
    org: "Wipro · clients HSBC and USAA",
    place: "Hyderabad, India",
    kind: "work",
    points: [
      "Front-end developer for HSBC; built MERN-stack projects while moving into web development.",
      "COBOL developer for USAA: delivered mainframe work, defined requirements with clients and mentored newer engineers.",
    ],
    tags: ["React", "Node", "MongoDB", "COBOL", "JCL"],
  },
  {
    period: "2015 – 2019",
    title: "B.Tech, Computer Science",
    org: "Siksha 'O' Anusandhan University",
    place: "Bhubaneswar, India",
    kind: "education",
    points: ["Graduated with a GPA of 8.32."],
    tags: [],
  },
];
