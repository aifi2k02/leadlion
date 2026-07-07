// Deterministic demo-data generator. Same keyword+location always yields the
// same businesses, so the app is fully explorable before a Google API key is
// added. Flagged with demo:true so the UI can show a banner.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FIRST = ['Golden', 'Prime', 'Elite', 'Sunny', 'Metro', 'Family', 'Rapid', 'Blue Sky', 'Cornerstone', 'Everest', 'Lakeside', 'Union', 'Heritage', 'Bright', 'Summit', 'Cardinal', 'Pioneer', 'Silverline', 'Oakwood', 'Downtown'];
const LAST = ['Solutions', 'Group', 'Co.', 'Services', 'Experts', 'Pros', 'Works', 'Bros', '& Sons', 'Studio', 'Center', 'Hub', 'Partners', 'Direct', 'Masters'];
const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Washington Blvd', '2nd Street', 'Park Rd', 'Riverside Ave', 'Elm St', 'Broadway', 'Hillcrest Dr'];

export function demoSearch(keyword, location) {
  const seed = hash(`${keyword.toLowerCase().trim()}|${location.toLowerCase().trim()}`);
  const rand = rng(seed);
  const count = 12 + Math.floor(rand() * 8);
  const kw = keyword.trim().replace(/^\w/, (c) => c.toUpperCase());
  const businesses = [];

  for (let i = 0; i < count; i++) {
    const r = rand();
    // Mix of strong, average, and weak listings so scoring shows range
    const tier = r < 0.3 ? 'weak' : r < 0.7 ? 'mid' : 'strong';
    const name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${kw} ${LAST[Math.floor(rand() * LAST.length)]}`;
    const hasWebsite = tier === 'strong' ? rand() > 0.05 : tier === 'mid' ? rand() > 0.4 : rand() > 0.8;
    const rating = tier === 'strong' ? 4.3 + rand() * 0.7 : tier === 'mid' ? 3.6 + rand() * 0.9 : rand() > 0.3 ? 2.5 + rand() * 1.5 : 0;
    const reviewCount = rating === 0 ? 0 : tier === 'strong' ? 60 + Math.floor(rand() * 300) : tier === 'mid' ? 8 + Math.floor(rand() * 45) : Math.floor(rand() * 9);

    businesses.push({
      placeId: `demo-${seed}-${i}`,
      demo: true,
      name,
      address: `${100 + Math.floor(rand() * 9800)} ${STREETS[Math.floor(rand() * STREETS.length)]}, ${location.trim()}`,
      category: kw,
      rating: rating ? Math.round(rating * 10) / 10 : null,
      reviewCount,
      website: hasWebsite ? `https://www.${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com` : null,
      phone: rand() > (tier === 'weak' ? 0.4 : 0.05) ? `(${200 + Math.floor(rand() * 700)}) 555-${String(1000 + Math.floor(rand() * 9000))}` : null,
      photoCount: tier === 'strong' ? 10 + Math.floor(rand() * 40) : tier === 'mid' ? Math.floor(rand() * 12) : Math.floor(rand() * 3),
      hasHours: tier === 'weak' ? rand() > 0.5 : rand() > 0.1,
      claimed: tier === 'weak' ? rand() > 0.55 : true,
      description: tier === 'strong' && rand() > 0.3 ? `Locally owned ${keyword.toLowerCase()} serving ${location.trim()} and surrounding areas.` : null,
      businessStatus: 'OPERATIONAL',
      mapsUrl: 'https://maps.google.com/?q=' + encodeURIComponent(name + ' ' + location),
    });
  }
  return businesses;
}
