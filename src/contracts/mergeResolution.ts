import { closed, enumeration, list, nonempty, stringsSchema, textSchema } from './runValidation.js';
export interface MergeResolution { files: { path: string; strategy: 'both' | 'ours' | 'theirs' | 'rewrite'; note: string }[]; unresolved: string[] }
export const mergeResolutionSchema = closed({ files: list(closed({ path: nonempty, strategy: enumeration('both', 'ours', 'theirs', 'rewrite'), note: textSchema })), unresolved: stringsSchema });
