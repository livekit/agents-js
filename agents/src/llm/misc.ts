import { v4 as uuidv4 } from 'uuid';

export function shortuuid(prefix: string): string {
  return `${prefix}_${uuidv4().slice(0, 12)}`;
}
