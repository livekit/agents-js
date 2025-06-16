import { v4 as uuidv4 } from 'uuid';

//TODO(AJS-60) refactor all calls to randomUUID to use this
export function shortuuid(prefix: string): string {
  return `${prefix}_${uuidv4().slice(0, 12)}`;
}
