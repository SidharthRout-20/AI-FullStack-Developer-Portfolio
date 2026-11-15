/**
 * Everything personal on the portfolio lives here: edit this file, not the components.
 * Content is taken from the resume in /documents. Empty strings are hidden automatically.
 */
export const SITE = {
  owner: "Sidharth Rout",
  role: "AI Full-Stack Developer",
  current: "Senior Consultant at Deloitte",
  location: "Bengaluru, India",
  /** Put a square photo at frontend/public/avatar.jpg and set '/avatar.jpg'. Empty → initials monogram. */
  avatar: "",
  headline: "I build AI products, from the model to the last pixel.",
  /** Shown as the hero stat and in the intro: keep in step with the resume. */
  years: 6,
  intro:
    "6 years of software development for global clients: I started on COBOL, moved into React UI development, and " +
    "today deliver Generative-AI proofs of concept at Deloitte as an LLM Engineer, with React frontends and Python " +
    "(Flask) backends. This site is my product lab: a portfolio of {products} AI products, built end to end with React 19 and Python, plus {labs} Labs experiments.",
  links: {
    github: "https://github.com/SidharthRout-20",
    linkedin: "https://www.linkedin.com/in/sidharth-rout-072696119/",
    email: "sidharthrout42@gmail.com",
  },
};

export const EXPERTISE = [
  {
    title: "Frontend & UI engineering",
    icon: "ui",
    text:
      "UI developer for enterprise clients (HP, Telefónica, HSBC): landing pages with skeleton loading, lazy loading " +
      "and mobile responsiveness, ContentStack CMS integrations, and legacy code brought up to modern standards.",
    stack: [
      "React",
      "Redux / RTK",
      "JavaScript (ES6+)",
      "HTML",
      "CSS",
      "Tailwind CSS",
      "Figma",
      "Adobe XD",
      "ContentStack",
    ],
  },
  {
    title: "Generative AI & agents",
    icon: "ai",
    text:
      "LLM Engineer on Deloitte client POCs (prompt design, API orchestration, LLM responses in React apps), and " +
      "the products and Labs apps on this site: RAG with citations, tool-using agents, structured outputs, speech and vision.",
    stack: [
      "LLMs",
      "RAG",
      "LangGraph",
      "Prompt engineering",
      "Agents & tools",
      "Claude",
      "Groq",
      "Whisper",
      "FastEmbed",
    ],
  },
  {
    title: "APIs, data & delivery",
    icon: "api",
    text:
      "Python (Flask) backends and REST API integrations for GenAI POCs, delivered with Agile tooling. Started my " +
      "career on COBOL mainframe systems for USAA.",
    stack: [
      "Python",
      "Flask",
      "FastAPI",
      "REST APIs",
      "MySQL",
      "MongoDB",
      "Docker",
      "Git / GitHub / GitLab",
      "Postman",
      "SauceLabs",
      "Jira",
      "COBOL",
    ],
  },
];

export const TIMELINE = [
  {
    period: "Dec 2023 – Present",
    title: "Senior Consultant",
    org: "Deloitte · AI & Data",
    place: "Gurgaon, India",
    kind: "work",
    points: [
      "Design and deliver Generative-AI POCs that integrate LLMs with React frontends and Python (Flask) backends, so enterprise clients can validate AI use cases quickly.",
      "LLM Engineer on client POCs: prompt design, API orchestration and frontend integration of LLM responses.",
      "Deliver solutions with cross-functional teams under tight deadlines; design UX wireframes in Figma.",
    ],
    tags: ["Generative AI", "LLMs", "React", "Flask", "Prompt engineering", "Figma"],
  },
  {
    period: "Apr 2022 – Sep 2023",
    title: "Senior Software Engineer",
    org: "Wipro · UI Developer for HP and Telefónica",
    place: "Bengaluru, India",
    kind: "work",
    points: [
      "Built a new landing page with skeleton loading, lazy loading and mobile responsiveness to client requirements.",
      "Contributed to ContentStack CMS integrations during a CMS migration, and updated legacy code bases to modern standards.",
      "Worked with project managers, architects and customers to resolve technical issues.",
    ],
    tags: ["React", "Redux Toolkit", "ContentStack", "Figma", "Adobe XD"],
  },
  {
    period: "May 2019 – Mar 2022",
    title: "Project Engineer",
    org: "Wipro · clients HSBC and USAA",
    place: "Hyderabad, India",
    kind: "work",
    points: [
      "Front-end developer for HSBC (May 2021 – Mar 2022), building MERN-stack projects while moving into web development.",
      "COBOL developer for USAA (May 2019 – Nov 2020): defined requirements with clients and mentored newer engineers.",
    ],
    tags: ["React", "Node", "MongoDB", "COBOL", "JCL", "Core Java"],
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
