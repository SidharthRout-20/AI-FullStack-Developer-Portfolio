/**
 * Who Tara answers as, picked per question. "Auto" lets Tara choose the right expert for each question; picking one
 * makes every answer come from that expert until you switch back. Keys match backend/app/keeper/personas.py.
 */
import {
  BarChart3, Briefcase, Building2, ChefHat, ClipboardList, Code2, Dumbbell, Feather, GraduationCap, HeartHandshake,
  Languages, Megaphone, MessagesSquare, PenTool, Plane, Rocket, Scale, Sparkles, Stethoscope, Wallet, Wand2,
} from 'lucide-react' // prettier-ignore

export const AUTO = { key: 'auto', label: 'Auto', hint: 'Tara picks the right expert for each question', icon: Wand2 }

export const PERSONAS = [
  { key: 'assistant', label: 'Everyday assistant', group: 'Everyday', hint: 'Quick help with anything', icon: Sparkles },
  { key: 'architect', label: 'Senior architect', group: 'Work', hint: 'System design and trade-offs', icon: Building2 },
  { key: 'engineer', label: 'Senior engineer', group: 'Work', hint: 'Code, bugs and how this app works', icon: Code2 },
  { key: 'product', label: 'Product owner', group: 'Work', hint: 'Priorities, stories, MVPs', icon: ClipboardList },
  { key: 'designer', label: 'UX designer', group: 'Work', hint: 'Flows, layout, accessibility', icon: PenTool },
  { key: 'data', label: 'Data analyst', group: 'Work', hint: 'Metrics, SQL, numbers', icon: BarChart3 },
  { key: 'marketer', label: 'Marketing strategist', group: 'Work', hint: 'Positioning and copy', icon: Megaphone },
  { key: 'founder', label: 'Startup advisor', group: 'Work', hint: 'Ideas, pricing, strategy', icon: Rocket },
  { key: 'interviewer', label: 'Interview coach', group: 'Career & learning', hint: 'Mock interviews, résumés', icon: MessagesSquare },
  { key: 'coach', label: 'Career coach', group: 'Career & learning', hint: 'Job moves and growth', icon: Briefcase },
  { key: 'teacher', label: 'Teacher', group: 'Career & learning', hint: 'Explains anything simply', icon: GraduationCap },
  { key: 'language', label: 'Language tutor', group: 'Career & learning', hint: 'Translate and practise', icon: Languages },
  { key: 'writer', label: 'Writer & editor', group: 'Career & learning', hint: 'Emails, posts, edits', icon: Feather },
  { key: 'therapist', label: 'Supportive listener', group: 'Life', hint: 'Talk things through', icon: HeartHandshake },
  { key: 'chef', label: 'Chef', group: 'Life', hint: 'Recipes from what you have', icon: ChefHat },
  { key: 'fitness', label: 'Fitness coach', group: 'Life', hint: 'Workouts and form', icon: Dumbbell },
  { key: 'health', label: 'Health guide', group: 'Life', hint: 'General info, not a diagnosis', icon: Stethoscope },
  { key: 'legal', label: 'Legal guide', group: 'Life', hint: 'General info, not legal advice', icon: Scale },
  { key: 'finance', label: 'Money coach', group: 'Life', hint: 'Budgets, loans, saving', icon: Wallet },
  { key: 'travel', label: 'Travel planner', group: 'Life', hint: 'Trips and itineraries', icon: Plane },
]

export const GROUPS = ['Everyday', 'Work', 'Career & learning', 'Life']
export const personaOf = (key) => (key === 'auto' ? AUTO : PERSONAS.find((p) => p.key === key) ?? AUTO)
