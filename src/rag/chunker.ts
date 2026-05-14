export interface Chunk {
  id: string;
  filePath: string;
  heading: string;
  headingPath: string;
  text: string;
  contentHash: string;
}

// Rough token count: 1 token ≈ 4 characters
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

interface Section {
  level: number;
  heading: string;
  headingPath: string;
  lines: string[];
}

function parseSections(content: string, filePath: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  const headingStack: string[] = [];

  let current: Section = {
    level: 0,
    heading: filePath,
    headingPath: "",
    lines: [],
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      if (current.lines.join("").trim()) {
        sections.push(current);
      }
      const level = match[1].length;
      const heading = match[2].trim();
      // Maintain heading breadcrumb
      headingStack.splice(level - 1, headingStack.length, heading);
      const headingPath = headingStack.slice(0, level).join(" › ");
      current = { level, heading, headingPath, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join("").trim()) {
    sections.push(current);
  }

  return sections;
}

function splitByParagraphs(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const combined = current ? `${current}\n\n${para}` : para;
    if (approxTokens(combined) > maxTokens && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = combined;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

export function chunkFile(
  content: string,
  filePath: string,
  maxTokens = 500,
  minTokens = 50
): Chunk[] {
  const sections = parseSections(content, filePath);
  const result: Chunk[] = [];
  let idx = 0;

  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;

    if (approxTokens(text) <= maxTokens) {
      if (approxTokens(text) >= minTokens) {
        result.push(makeChunk(filePath, section, text, idx++));
      }
      // Skip very short sections (will be merged heuristically below)
      continue;
    }

    // Section too long — split by paragraphs
    const parts = splitByParagraphs(text, maxTokens);
    for (const part of parts) {
      if (approxTokens(part) >= minTokens) {
        result.push(makeChunk(filePath, section, part, idx++));
      }
    }
  }

  return result;
}

function makeChunk(
  filePath: string,
  section: Section,
  text: string,
  idx: number
): Chunk {
  const id = `${filePath}::${idx}`;
  return {
    id,
    filePath,
    heading: section.heading,
    headingPath: section.headingPath,
    text,
    contentHash: simpleHash(text),
  };
}
