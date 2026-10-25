const paths={
  home:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  analytics:'M3 4v16h18 M7 13h4 M11 8h5 M16 16h5',
  lab:'M3 20h18 M6 16v-5 M12 16V4 M18 16V8',
  connections:'M9 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M6 21v-2a6 6 0 0 1 12 0v2 M3 8v5 M1 10.5h4 M21 8v5 M19 10.5h4',
  journey:'M6 6l12 3 M6 6l4 13 M18 9l-8 10 M3 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M15 9a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M7 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  friends:'M8 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M4 21v-3a7 7 0 0 1 14 0v3 M17 4a3 3 0 0 1 0 6 M20 14a4 4 0 0 1 2 4v3',
  ranking:'M3 21h18 M4 21V11h5v10 M9 21V4h6v17 M15 21v-7h5v7',
  history:'M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v6l4 2',
  settings:'M5 3v18 M12 3v18 M19 3v18 M2 8h6 M9 16h6 M16 9h6',
  help:'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M9 8a3 3 0 1 1 4 3c-1 .6-1 1-1 3 M12 17v1'
};
export function initializeNavigationIcons(){
  for(const button of document.querySelectorAll('[data-tab]')){
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(icon.namespaceURI,'path');
    icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.classList.add('nav-icon');path.setAttribute('d',paths[button.dataset.tab]);icon.append(path);button.prepend(icon);
  }
}
