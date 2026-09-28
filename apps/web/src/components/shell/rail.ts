import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

const RAIL_KEY = 'cw:sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the sidebar is folded into its icon rail, kept across visits. */
export function useRailCollapsed(): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      // private mode: the preference just does not persist
    }
  }, [collapsed]);
  return [collapsed, setCollapsed];
}
