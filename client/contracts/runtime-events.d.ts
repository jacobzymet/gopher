interface AppUpdateStatus {
  current: string; latest: string | null; commit_url: string;
  update_available: boolean; can_install: boolean; checked: boolean;
  current_commit?: string | null; branch?: string; error?: string | null;
  install_blocked?: string;
}
interface RuntimeApiProblem { error?: string }
interface RuntimeSkillsResponse extends RuntimeApiProblem { skills?: UserSkill[] }
interface RuntimeSkillResponse extends UserSkill, RuntimeApiProblem {}
