import { App } from "obsidian";

export interface Workflow {
  name: string;
  content: string;
}

const PLUGIN_FOLDER = "plugins/ask-my-notes";

export async function loadWorkflows(app: App): Promise<Workflow[]> {
  const folderPath = `${app.vault.configDir}/${PLUGIN_FOLDER}/workflows`;
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(folderPath))) return [];
  const { files } = await adapter.list(folderPath);
  const workflows: Workflow[] = [];
  for (const filePath of files.filter((f) => f.endsWith(".md")).sort()) {
    const name = filePath.split("/").pop()!.replace(/\.md$/, "");
    const content = await adapter.read(filePath);
    workflows.push({ name, content });
  }
  return workflows;
}

export function applyWorkflow(workflow: Workflow, query: string): string {
  if (workflow.content.includes("$ARGUMENTS")) {
    return workflow.content.replace(/\$ARGUMENTS/g, query);
  }
  return query ? `${workflow.content}\n\n${query}` : workflow.content;
}

export function workflowDescription(content: string): string {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return lines[0]?.slice(0, 70) ?? "";
}
