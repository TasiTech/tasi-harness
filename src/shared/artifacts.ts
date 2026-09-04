import type { AgentArtifactKind, AgentArtifactPreviewMode } from './types.js';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.html', '.htm'
]);
const CODE_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.xml', '.css', '.js', '.jsx',
  '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.rb', '.sh', '.sql', '.toml', '.ini', '.env'
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const MODEL3D_EXTENSIONS = new Set(['.stl', '.obj', '.glb', '.gltf']);
const MEDIA_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov']);
const OFFICE_PREVIEW_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx']);
const OFFICE_LEGACY_EXTENSIONS = new Set(['.doc', '.ppt', '.xls']);
const OFFICE_EXTENSIONS = new Set([...OFFICE_PREVIEW_EXTENSIONS, ...OFFICE_LEGACY_EXTENSIONS]);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz']);
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.msi', '.bat', '.cmd', '.ps1']);
const DATABASE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

export const ARTIFACT_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...MODEL3D_EXTENSIONS,
  ...MEDIA_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
  ...DATABASE_EXTENSIONS
]);

export function classifyArtifactKind(ext: string): AgentArtifactKind {
  const clean = ext.toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(clean)) return 'executable';
  if (MARKDOWN_EXTENSIONS.has(clean)) return 'markdown';
  if (CODE_EXTENSIONS.has(clean)) return 'text';
  if (TEXT_EXTENSIONS.has(clean)) return 'text';
  if (IMAGE_EXTENSIONS.has(clean)) return 'image';
  if (PDF_EXTENSIONS.has(clean)) return 'pdf';
  if (MODEL3D_EXTENSIONS.has(clean)) return 'model3d';
  if (MEDIA_EXTENSIONS.has(clean)) return 'media';
  if (OFFICE_EXTENSIONS.has(clean)) return 'office';
  if (ARCHIVE_EXTENSIONS.has(clean)) return 'archive';
  if (DATABASE_EXTENSIONS.has(clean)) return 'database';
  return 'unknown';
}

export function previewModeForArtifact(ext: string): AgentArtifactPreviewMode {
  const kind = classifyArtifactKind(ext);
  if (kind === 'markdown') return 'markdown';
  if (CODE_EXTENSIONS.has(ext.toLowerCase())) return 'code';
  if (kind === 'text') return 'text';
  if (kind === 'image') return 'image';
  if (kind === 'pdf') return 'pdf';
  if (kind === 'model3d') return 'model3d';
  if (kind === 'media') return 'media';
  if (kind === 'office') return OFFICE_PREVIEW_EXTENSIONS.has(ext.toLowerCase()) ? 'office' : 'external';
  if (kind === 'archive' || kind === 'executable' || kind === 'database') return 'external';
  return 'none';
}

export function isArtifactExtension(ext: string): boolean {
  return ARTIFACT_EXTENSIONS.has(ext.toLowerCase());
}

export function decodeArtifactPathText(value: string): string {
  let current = value.trim();
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

export function mimeTypeForArtifact(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.md':
    case '.markdown':
    case '.mdx':
      return 'text/markdown';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    case '.stl':
      return 'model/stl';
    case '.obj':
      return 'model/obj';
    case '.glb':
      return 'model/gltf-binary';
    case '.gltf':
      return 'model/gltf+json';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
