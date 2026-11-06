// The read-only line's id as a Button's `describedBy`, or nothing outside view-as.
export function described(readOnlyId: string | null): { describedBy?: string } {
  return readOnlyId === null ? {} : { describedBy: readOnlyId };
}
