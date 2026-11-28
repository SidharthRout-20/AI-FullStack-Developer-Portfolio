/**
 * Everything personal on the portfolio lives here: edit this file, not the components.
 * Content is taken from the resume in /documents. Empty strings are hidden automatically.
 */
export const SITE = {
  owner: "Sidharth Rout",
  role: "AI Full-Stack Developer",
  current: "Senior Consultant at Deloitte",
  location: "Bengaluru, India",
  /** Your local time is shown in the personal space ("9:41 pm here"). IANA time zone name. */
  timeZone: "Asia/Kolkata",
  /** "Now" notes in the personal space: what you're actually working on. Keep them true; empty array hides them. */
  now: [
    "Taking Safarnaama end to end, from the first idea to the booking",
    "Teaching an LLM router to live on Groq's free tier",
    "Making Jasoos explain failing builds with evidence",
  ],
  /**
   * Your photo: save a square image (at least 600×600) as frontend/public/me.jpg. It is used for the polaroid in
   * Off the clock and the small portraits in the headers. Until the file exists, a placeholder is shown.
   */
  avatar: "/me.jpg",
  /** A tight crop of your face for the small round portraits (headers, the switch). Empty → the photo above. */
  avatarFace: "/me-face.jpg",
  /** Handwritten caption under the polaroid. Empty → "Bengaluru, <year>". */
  photoCaption: "",
  /** Link to a PDF résumé (e.g. put it at frontend/public/resume.pdf and set "/resume.pdf"). Empty → button hidden. */
  resume: "",
  headline: "I build AI products, from the model to the last pixel.",
  /** One line under the Studio headline. Keep it true; empty hides it. */
  availability: "Open to AI product engineering roles and collaborations",
  /**
   * Client work, without client names: the site never names a client served through an employer (the résumé does;
   * the backend redacts it too, see backend/app/rag/redact.py). Shown as a count and as industries.
   */
  clientCount: 4,
  industries: ["Technology", "Telecom", "Banking", "Financial services"],
  /** The Studio's scroll-lit statement: the short story of your career, in your own words. */
  statement:
    "I started on COBOL mainframes for a US financial-services client, moved into React interfaces for global " +
    "technology, telecom and banking clients, and today " +
    "deliver Generative-AI proofs of concept at Deloitte. In my own time I build AI products end to end: the model, " +
    "the API, and every pixel in between.",
  /** Shown as the hero stat and in the intro: keep in step with the resume. */
  years: 6,
  /** Kept on purpose, not shown anywhere (owner's decision, Nov 2026). {products} is filled by fillCounts(). */
  intro:
    "6 years of software development for global clients: I started on COBOL, moved into React UI development, and " +
    "today deliver Generative-AI proofs of concept at Deloitte as an LLM Engineer, with React frontends and Python " +
    "(Flask) backends. This site is my product lab: {products} AI products that each solve one real problem end to end, built with React 19 and Python (more in development).",
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
      "UI developer for global technology, telecom and banking clients: landing pages with skeleton loading, lazy loading " +
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
      "the products on this site: RAG with citations, tool-using agents, structured outputs, speech and vision.",
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
      "career on COBOL mainframe systems for a US financial-services client.",
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
    org: "Wipro · UI Developer for technology and telecom clients",
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
    org: "Wipro · banking and financial-services clients",
    place: "Hyderabad, India",
    kind: "work",
    points: [
      "Front-end developer for a global bank (May 2021 – Mar 2022), building MERN-stack projects while moving into web development.",
      "COBOL developer for a US financial-services client (May 2019 – Nov 2020): defined requirements with clients and mentored newer engineers.",
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
