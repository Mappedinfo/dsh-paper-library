// Keep existing shared board links at the old Pages root.
const boardLink = new URLSearchParams(location.search).has('src');
const destination = new URL(boardLink ? './board.html' : './library/', location.href);
if (boardLink) destination.search = location.search;
destination.hash = location.hash;
location.replace(destination.href);
