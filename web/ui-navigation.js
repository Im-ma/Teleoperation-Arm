// Keep the existing robot-auth fragment on local page links without storing it.
(() => {
  const fragment = location.hash;
  const authenticated = new URLSearchParams(fragment.slice(1)).has('key');
  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      link.addEventListener('click', event => {
        const target = document.getElementById(href.slice(1));
        if (!target) return;
        event.preventDefault();
        if (target.tagName === 'DETAILS') target.open = true;
        target.scrollIntoView({ block: 'start' });
        target.focus({ preventScroll: true });
      });
    } else if (authenticated) {
      const url = new URL(href, location.href);
      if (url.origin === location.origin && ['/', '/web/index.html', '/web/replay.html', '/web/profile.html'].includes(url.pathname)) {
        url.hash = fragment;
        link.href = url.href;
      }
    }
  }
})();
