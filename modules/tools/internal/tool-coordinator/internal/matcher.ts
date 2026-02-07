import { Minimatch } from 'minimatch';

export function compileMatcher(match: { type: string; pattern: any }): (value: string) => boolean {
  const matchType = match.type;
  const pattern = match.pattern;
  switch (matchType) {
    case 'exact':
      return (value: string) => value === pattern;
    case 'prefix':
      return (value: string) => value.startsWith(pattern);
    case 'regex': {
      try {
        const regex = new RegExp(pattern);
        return (value: string) => regex.test(value);
      } catch (error: any) {
        return () => {
          throw error;
        };
      }
    }
    case 'glob': {
      try {
        const matcher = new Minimatch(pattern);
        return (value: string) => matcher.match(value);
      } catch (error: any) {
        return () => {
          throw error;
        };
      }
    }
    default:
      return () => false;
  }
}
