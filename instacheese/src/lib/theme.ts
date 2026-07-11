import { useColorScheme } from 'react-native';

export const accent = '#F5A623'; // cheese
export const likeColor = '#ED4956'; // bullhorn/like
export const starColor = '#F5C518';

export interface Palette {
  background: string;
  card: string;
  text: string;
  subtleText: string;
  border: string;
  inputBackground: string;
}

const light: Palette = {
  background: '#FAFAFA',
  card: '#FFFFFF',
  text: '#111111',
  subtleText: '#737373',
  border: '#E3E3E3',
  inputBackground: '#F1F1F1',
};

const dark: Palette = {
  background: '#000000',
  card: '#121212',
  text: '#F5F5F5',
  subtleText: '#A0A0A0',
  border: '#262626',
  inputBackground: '#1E1E1E',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}
