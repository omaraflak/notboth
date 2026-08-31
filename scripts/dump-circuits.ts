/** Print each component of a saved project in the editor's text form. */
import { readFileSync } from 'node:fs';
import { toText } from '../src/core/hdl';
import type { Project } from '../src/core/types';

const project: Project = JSON.parse(readFileSync(process.argv[2], 'utf8')).project;
const out: Record<string, string> = {};
for (const def of project.defs) out[def.name] = toText(project, def);
process.stdout.write(JSON.stringify(out, null, 1));
