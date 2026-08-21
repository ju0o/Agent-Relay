import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const appRoot = document.getElementById('app');
if (!appRoot) throw new Error('#app 루트 요소가 없습니다.');

createRoot(appRoot).render(<App />);