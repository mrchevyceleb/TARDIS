import { installContentTeam } from '../src/chat/content-team.ts';

const result = await installContentTeam();
console.log(result.installed ? `Content team ready: ${result.agents.length} agents.` : 'Content team already installed; your changes were preserved.');
