/**
 * Safarnaama's quick planner: a whole trip from four taps (where → when → who → plan), no typing needed.
 * Pure helpers (unit-tested in choices.test.js). The choices become a precise request for the existing AI planner
 * (POST /api/trips/plan), so places, weather and routes still come from real provider data.
 *
 * The destination pool is a hand-picked list of real places with a short, general description each. It names no
 * businesses and makes no claims about prices, ratings or availability.
 */

/**
 * months: when the place is at its best (1–12). days: a comfortable first visit. iata/airport: the nearest passenger
 * airport (for flight searches). mmt: MakeMyTrip's city code, where known (for its pre-filled hotel search).
 * region: the state, sent to the planner so a namesake can't win (Manali, Himachal, not the Chennai suburb).
 * Every name here was checked against Safarnaama's own geocoder (it lands within a few km of the real place).
 */
export const DESTINATIONS = [
  { name: 'Goa', iata: 'GOI', airport: 'Goa (GOI)', mmt: 'CTGOI', country: 'India', hook: 'Beaches, Portuguese-era churches and seafood', days: 4, tags: ['beaches', 'food', 'nightlife'], months: [11, 12, 1, 2, 3], tint: 'from-amber-400 via-orange-500 to-rose-500' },
  { name: 'Jaipur', region: 'Rajasthan', iata: 'JAI', airport: 'Jaipur (JAI)', mmt: 'CTJAI', country: 'India', hook: 'Forts, palaces and bazaars of the Pink City', days: 3, tags: ['heritage', 'shopping', 'food'], months: [10, 11, 12, 1, 2, 3], tint: 'from-rose-400 via-pink-500 to-orange-400' },
  { name: 'Udaipur', region: 'Rajasthan', iata: 'UDR', airport: 'Udaipur (UDR)', mmt: 'CTUDR', country: 'India', hook: 'Lakes, palaces and sunset rooftops', days: 3, tags: ['heritage', 'romance', 'photography'], months: [9, 10, 11, 12, 1, 2, 3], tint: 'from-sky-400 via-indigo-500 to-violet-500' },
  { name: 'Varanasi', region: 'Uttar Pradesh', iata: 'VNS', airport: 'Varanasi (VNS)', mmt: 'CTVNS', country: 'India', hook: 'Ghats, dawn boat rides and the evening aarti', days: 2, tags: ['culture', 'spiritual', 'food'], months: [10, 11, 12, 1, 2, 3], tint: 'from-orange-400 via-amber-500 to-yellow-400' },
  { name: 'Rishikesh', region: 'Uttarakhand', iata: 'DED', airport: 'Dehradun (DED)', country: 'India', hook: 'Yoga, river rafting and foothill trails', days: 3, tags: ['wellness', 'adventure', 'nature'], months: [9, 10, 11, 2, 3, 4, 5], tint: 'from-emerald-400 via-teal-500 to-cyan-500' },
  { name: 'Munnar', region: 'Kerala', iata: 'COK', airport: 'Kochi (COK)', country: 'India', hook: 'Tea estates, misty hills and spice gardens', days: 3, tags: ['nature', 'relaxed', 'photography'], months: [9, 10, 11, 12, 1, 2, 3, 4, 5], tint: 'from-lime-400 via-green-500 to-emerald-600' },
  { name: 'Alappuzha', region: 'Kerala', iata: 'COK', airport: 'Kochi (COK)', country: 'India', hook: 'Kerala backwaters, by houseboat', days: 2, tags: ['nature', 'relaxed', 'food'], months: [9, 10, 11, 12, 1, 2, 3], tint: 'from-teal-400 via-emerald-500 to-green-600' },
  { name: 'Hampi', region: 'Karnataka', iata: 'VDY', airport: 'Vijayanagar (VDY)', country: 'India', hook: 'Boulder hills and Vijayanagara temple ruins', days: 2, tags: ['heritage', 'photography', 'adventure'], months: [10, 11, 12, 1, 2], tint: 'from-amber-500 via-orange-600 to-red-600' },
  { name: 'Puducherry', region: 'Puducherry', iata: 'MAA', airport: 'Chennai (MAA)', country: 'India', hook: 'French Quarter lanes, cafés and quiet beaches', days: 3, tags: ['food', 'beaches', 'relaxed'], months: [10, 11, 12, 1, 2, 3], tint: 'from-yellow-300 via-amber-400 to-orange-500' },
  { name: 'Leh', region: 'Ladakh', iata: 'IXL', airport: 'Leh (IXL)', mmt: 'CTIXL', country: 'India', hook: 'High passes, monasteries and mountain lakes', days: 5, tags: ['adventure', 'nature', 'photography'], months: [6, 7, 8, 9], tint: 'from-sky-400 via-blue-500 to-indigo-600' },
  { name: 'Darjeeling', region: 'West Bengal', iata: 'IXB', airport: 'Bagdogra (IXB)', country: 'India', hook: 'The toy train, tea gardens and Himalayan views', days: 3, tags: ['nature', 'heritage', 'relaxed'], months: [3, 4, 5, 10, 11], tint: 'from-green-400 via-emerald-500 to-teal-600' },
  { name: 'Kodagu', region: 'Karnataka', iata: 'IXE', airport: 'Mangaluru (IXE)', country: 'India', hook: 'Coffee estates, waterfalls and misty forests', days: 3, tags: ['nature', 'relaxed', 'food'], months: [10, 11, 12, 1, 2, 3, 4, 5], tint: 'from-emerald-500 via-green-600 to-lime-500' },
  { name: 'Kyoto', iata: 'KIX', airport: 'Osaka Kansai (KIX)', country: 'Japan', hook: 'Temples, tea houses and old wooden streets', days: 4, tags: ['culture', 'food', 'heritage'], months: [3, 4, 5, 10, 11], tint: 'from-pink-400 via-rose-500 to-red-500' },
  { name: 'Lisbon', iata: 'LIS', airport: 'Lisbon (LIS)', country: 'Portugal', hook: 'Viewpoints, old trams and food markets', days: 3, tags: ['food', 'culture', 'photography'], months: [4, 5, 6, 9, 10], tint: 'from-yellow-400 via-amber-500 to-sky-500' },
  { name: 'Bali', iata: 'DPS', airport: 'Denpasar (DPS)', country: 'Indonesia', hook: 'Rice terraces, temples and surf beaches', days: 5, tags: ['beaches', 'wellness', 'nature'], months: [4, 5, 6, 7, 8, 9, 10], tint: 'from-emerald-400 via-cyan-500 to-blue-500' },
  { name: 'Singapore', iata: 'SIN', airport: 'Singapore (SIN)', country: 'Singapore', hook: 'Hawker food, gardens and a skyline by the bay', days: 3, tags: ['food', 'family', 'shopping'], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], tint: 'from-red-400 via-rose-500 to-fuchsia-500' },
  { name: 'Istanbul', iata: 'IST', airport: 'Istanbul (IST)', country: 'Türkiye', hook: 'Bazaars, mosques and ferries on the Bosphorus', days: 4, tags: ['culture', 'food', 'shopping'], months: [4, 5, 9, 10, 11], tint: 'from-indigo-400 via-violet-500 to-fuchsia-500' },
  { name: 'Kathmandu', iata: 'KTM', airport: 'Kathmandu (KTM)', country: 'Nepal', hook: 'Durbar squares, stupas and mountain views', days: 4, tags: ['culture', 'heritage', 'adventure'], months: [3, 4, 10, 11], tint: 'from-red-500 via-orange-500 to-amber-400' },
  { name: 'Manali', region: 'Himachal Pradesh', iata: 'KUU', airport: 'Kullu–Manali (KUU)', country: 'India', hook: 'Snow peaks, apple orchards and riverside walks', days: 4, tags: ['nature', 'adventure', 'relaxed'], months: [3, 4, 5, 6, 10, 12, 1], tint: 'from-sky-400 via-cyan-500 to-teal-500' },
  { name: 'Shimla', region: 'Himachal Pradesh', iata: 'IXC', airport: 'Chandigarh (IXC)', country: 'India', hook: 'Colonial hill town, the Ridge and the toy train', days: 3, tags: ['heritage', 'nature', 'relaxed'], months: [3, 4, 5, 6, 10, 11, 12], tint: 'from-emerald-400 via-teal-500 to-sky-500' },
  { name: 'Dharamshala', region: 'Himachal Pradesh', iata: 'DHM', airport: 'Kangra (DHM)', country: 'India', hook: 'Tibetan monasteries, cedar forests and the Triund trail', days: 3, tags: ['spiritual', 'adventure', 'nature'], months: [3, 4, 5, 6, 9, 10, 11], tint: 'from-amber-400 via-orange-500 to-red-500' },
  { name: 'Srinagar', region: 'Jammu and Kashmir', iata: 'SXR', airport: 'Srinagar (SXR)', country: 'India', hook: 'Dal Lake shikaras, Mughal gardens and houseboats', days: 4, tags: ['nature', 'romance', 'photography'], months: [4, 5, 6, 7, 8, 9, 10], tint: 'from-sky-400 via-blue-500 to-indigo-500' },
  { name: 'Amritsar', region: 'Punjab', iata: 'ATQ', airport: 'Amritsar (ATQ)', country: 'India', hook: 'The Golden Temple, langar and the border ceremony', days: 2, tags: ['spiritual', 'food', 'heritage'], months: [10, 11, 12, 1, 2, 3], tint: 'from-yellow-300 via-amber-400 to-orange-500' },
  { name: 'Agra', region: 'Uttar Pradesh', iata: 'AGR', airport: 'Agra (AGR)', country: 'India', hook: 'The Taj Mahal at sunrise and the red-stone fort', days: 2, tags: ['heritage', 'photography', 'culture'], months: [10, 11, 12, 1, 2, 3], tint: 'from-rose-300 via-pink-400 to-orange-300' },
  { name: 'Delhi', region: 'Delhi', iata: 'DEL', airport: 'Delhi (DEL)', country: 'India', hook: 'Mughal monuments, old bazaars and street food', days: 3, tags: ['heritage', 'food', 'shopping'], months: [10, 11, 12, 1, 2, 3], tint: 'from-orange-400 via-rose-500 to-fuchsia-500' },
  { name: 'Jodhpur', region: 'Rajasthan', iata: 'JDH', airport: 'Jodhpur (JDH)', country: 'India', hook: 'The Blue City below Mehrangarh Fort', days: 2, tags: ['heritage', 'food', 'photography'], months: [10, 11, 12, 1, 2, 3], tint: 'from-sky-500 via-blue-600 to-indigo-600' },
  { name: 'Jaisalmer', region: 'Rajasthan', iata: 'JSA', airport: 'Jaisalmer (JSA)', country: 'India', hook: 'A golden sandstone fort and Thar desert dunes', days: 3, tags: ['heritage', 'adventure', 'photography'], months: [10, 11, 12, 1, 2], tint: 'from-amber-300 via-yellow-500 to-orange-500' },
  { name: 'Bhuj', region: 'Gujarat', iata: 'BHJ', airport: 'Bhuj (BHJ)', country: 'India', hook: 'Gateway to the white salt desert of the Rann of Kutch', days: 3, tags: ['culture', 'photography', 'nature'], months: [11, 12, 1, 2], tint: 'from-slate-200 via-sky-300 to-indigo-400' },
  { name: 'Mumbai', region: 'Maharashtra', iata: 'BOM', airport: 'Mumbai (BOM)', country: 'India', hook: 'Marine Drive, street food and the Gateway of India', days: 3, tags: ['food', 'culture', 'nightlife'], months: [10, 11, 12, 1, 2, 3], tint: 'from-indigo-400 via-violet-500 to-fuchsia-500' },
  { name: 'Mahabaleshwar', region: 'Maharashtra', iata: 'PNQ', airport: 'Pune (PNQ)', country: 'India', hook: 'Valley viewpoints, strawberry farms and misty hills', days: 2, tags: ['nature', 'relaxed', 'family'], months: [10, 11, 12, 1, 2, 3, 4, 5], tint: 'from-lime-400 via-emerald-500 to-teal-600' },
  { name: 'Mount Abu', region: 'Rajasthan', iata: 'UDR', airport: 'Udaipur (UDR)', country: 'India', hook: 'Rajasthan\'s hill station and the carved Dilwara temples', days: 2, tags: ['nature', 'heritage', 'relaxed'], months: [10, 11, 12, 1, 2, 3, 4, 5, 6], tint: 'from-teal-400 via-emerald-500 to-lime-500' },
  { name: 'Khajuraho', region: 'Madhya Pradesh', iata: 'HJR', airport: 'Khajuraho (HJR)', country: 'India', hook: 'Thousand-year-old carved temples', days: 2, tags: ['heritage', 'culture', 'photography'], months: [10, 11, 12, 1, 2, 3], tint: 'from-orange-300 via-amber-500 to-rose-500' },
  { name: 'Bodh Gaya', region: 'Bihar', iata: 'GAY', airport: 'Gaya (GAY)', country: 'India', hook: 'Where the Buddha found enlightenment', days: 2, tags: ['spiritual', 'heritage', 'culture'], months: [10, 11, 12, 1, 2, 3], tint: 'from-amber-400 via-orange-400 to-yellow-300' },
  { name: 'Kolkata', region: 'West Bengal', iata: 'CCU', airport: 'Kolkata (CCU)', country: 'India', hook: 'Colonial streets, sweets and the Howrah Bridge', days: 3, tags: ['culture', 'food', 'heritage'], months: [10, 11, 12, 1, 2], tint: 'from-yellow-400 via-amber-500 to-red-500' },
  { name: 'Gangtok', region: 'Sikkim', iata: 'IXB', airport: 'Bagdogra (IXB)', country: 'India', hook: 'Monasteries, Kanchenjunga views and high lakes', days: 3, tags: ['nature', 'spiritual', 'adventure'], months: [3, 4, 5, 10, 11, 12], tint: 'from-cyan-400 via-sky-500 to-blue-600' },
  { name: 'Shillong', region: 'Meghalaya', iata: 'GAU', airport: 'Guwahati (GAU)', country: 'India', hook: 'Pine hills, waterfalls and live music', days: 3, tags: ['nature', 'adventure', 'culture'], months: [3, 4, 5, 10, 11], tint: 'from-green-400 via-emerald-500 to-cyan-600' },
  { name: 'Port Blair', region: 'Andaman and Nicobar Islands', iata: 'IXZ', airport: 'Port Blair (IXZ)', country: 'India', hook: 'Gateway to the Andaman islands, reefs and beaches', days: 5, tags: ['beaches', 'adventure', 'heritage'], months: [11, 12, 1, 2, 3, 4], tint: 'from-cyan-300 via-teal-400 to-blue-500' },
  { name: 'Hyderabad', region: 'Telangana', iata: 'HYD', airport: 'Hyderabad (HYD)', country: 'India', hook: 'The Charminar, biryani and Golconda Fort', days: 2, tags: ['food', 'heritage', 'shopping'], months: [10, 11, 12, 1, 2], tint: 'from-amber-400 via-orange-500 to-pink-500' },
  { name: 'Mysuru', region: 'Karnataka', iata: 'BLR', airport: 'Bengaluru (BLR)', country: 'India', hook: 'The lit-up palace, silk and sandalwood', days: 2, tags: ['heritage', 'culture', 'food'], months: [9, 10, 11, 12, 1, 2], tint: 'from-yellow-300 via-orange-400 to-rose-500' },
  { name: 'Ooty', region: 'Tamil Nadu', iata: 'CJB', airport: 'Coimbatore (CJB)', country: 'India', hook: 'Nilgiri tea slopes and the mountain railway', days: 3, tags: ['nature', 'relaxed', 'family'], months: [3, 4, 5, 6, 9, 10, 11], tint: 'from-emerald-400 via-green-500 to-lime-500' },
  { name: 'Kochi', region: 'Kerala', iata: 'COK', airport: 'Kochi (COK)', country: 'India', hook: 'Fishing nets, Fort Kochi lanes and spice markets', days: 2, tags: ['heritage', 'food', 'culture'], months: [9, 10, 11, 12, 1, 2, 3], tint: 'from-teal-400 via-cyan-500 to-sky-500' },
  { name: 'Varkala', region: 'Kerala', iata: 'TRV', airport: 'Thiruvananthapuram (TRV)', country: 'India', hook: 'Red cliffs above a long, quiet beach', days: 3, tags: ['beaches', 'wellness', 'relaxed'], months: [10, 11, 12, 1, 2, 3], tint: 'from-orange-300 via-rose-400 to-pink-500' },
  { name: 'Wayanad', region: 'Kerala', iata: 'CCJ', airport: 'Kozhikode (CCJ)', country: 'India', hook: 'Forests, waterfalls and spice plantations', days: 3, tags: ['nature', 'adventure', 'relaxed'], months: [10, 11, 12, 1, 2, 3, 4, 5], tint: 'from-green-500 via-emerald-600 to-teal-700' },
  { name: 'Gokarna', region: 'Karnataka', iata: 'GOI', airport: 'Goa (GOI)', country: 'India', hook: 'Quiet beaches, cliff trails and a temple town', days: 3, tags: ['beaches', 'relaxed', 'spiritual'], months: [10, 11, 12, 1, 2, 3], tint: 'from-sky-300 via-cyan-400 to-emerald-500' },
  { name: 'Madurai', region: 'Tamil Nadu', iata: 'IXM', airport: 'Madurai (IXM)', country: 'India', hook: 'The Meenakshi Temple\'s towers and Tamil food', days: 2, tags: ['spiritual', 'heritage', 'food'], months: [10, 11, 12, 1, 2, 3], tint: 'from-fuchsia-400 via-pink-500 to-orange-400' },
  { name: 'Nainital', region: 'Uttarakhand', iata: 'PGH', airport: 'Pantnagar (PGH)', country: 'India', hook: 'A lake town ringed by hills', days: 2, tags: ['nature', 'relaxed', 'family'], months: [3, 4, 5, 6, 10, 11], tint: 'from-sky-400 via-indigo-400 to-violet-500' },
  { name: 'Dubai', iata: 'DXB', airport: 'Dubai (DXB)', country: 'United Arab Emirates', hook: 'Desert dunes, old souks and a skyline of towers', days: 4, tags: ['shopping', 'family', 'adventure'], months: [11, 12, 1, 2, 3], tint: 'from-amber-300 via-orange-400 to-rose-500' },
  { name: 'Bangkok', iata: 'BKK', airport: 'Bangkok (BKK)', country: 'Thailand', hook: 'Temples, river boats and street food', days: 3, tags: ['food', 'culture', 'nightlife'], months: [11, 12, 1, 2], tint: 'from-orange-400 via-amber-500 to-yellow-400' },
  { name: 'Phuket', iata: 'HKT', airport: 'Phuket (HKT)', country: 'Thailand', hook: 'Island beaches, viewpoints and boat trips', days: 4, tags: ['beaches', 'nightlife', 'adventure'], months: [11, 12, 1, 2, 3, 4], tint: 'from-cyan-400 via-teal-500 to-emerald-500' },
  { name: 'Malé', iata: 'MLE', airport: 'Malé (MLE)', country: 'Maldives', hook: 'Gateway to turquoise lagoons and coral reefs', days: 4, tags: ['beaches', 'romance', 'relaxed'], months: [11, 12, 1, 2, 3, 4], tint: 'from-cyan-300 via-sky-400 to-blue-500' },
  { name: 'Kandy', iata: 'CMB', airport: 'Colombo (CMB)', country: 'Sri Lanka', hook: 'The Temple of the Tooth and hill-country tea', days: 3, tags: ['spiritual', 'nature', 'heritage'], months: [12, 1, 2, 3, 4], tint: 'from-emerald-400 via-teal-500 to-cyan-600' },
  { name: 'Paro', iata: 'PBH', airport: 'Paro (PBH)', country: 'Bhutan', hook: 'Tiger\'s Nest above a pine valley', days: 4, tags: ['spiritual', 'adventure', 'nature'], months: [3, 4, 5, 9, 10, 11], tint: 'from-amber-400 via-red-500 to-rose-600' },
  { name: 'Pokhara', iata: 'PKR', airport: 'Pokhara (PKR)', country: 'Nepal', hook: 'A lakeside town under the Annapurna range', days: 3, tags: ['nature', 'adventure', 'relaxed'], months: [3, 4, 10, 11], tint: 'from-sky-400 via-blue-500 to-violet-500' },
  { name: 'Hanoi', iata: 'HAN', airport: 'Hanoi (HAN)', country: 'Vietnam', hook: 'Old Quarter lanes, pho and the way to Ha Long Bay', days: 3, tags: ['food', 'culture', 'heritage'], months: [10, 11, 12, 3, 4], tint: 'from-red-400 via-rose-500 to-amber-400' },
  { name: 'Hoi An', iata: 'DAD', airport: 'Da Nang (DAD)', country: 'Vietnam', hook: 'A lantern-lit old town by the river', days: 3, tags: ['heritage', 'food', 'photography'], months: [2, 3, 4, 5, 6, 7], tint: 'from-yellow-300 via-amber-400 to-orange-500' },
  { name: 'Kuala Lumpur', iata: 'KUL', airport: 'Kuala Lumpur (KUL)', country: 'Malaysia', hook: 'Twin towers, Batu Caves and hawker food', days: 3, tags: ['food', 'shopping', 'family'], months: [1, 2, 3, 6, 7, 8], tint: 'from-indigo-400 via-sky-500 to-cyan-400' },
  { name: 'Tokyo', iata: 'HND', airport: 'Tokyo Haneda (HND)', country: 'Japan', hook: 'Neon nights, shrines and food halls', days: 5, tags: ['food', 'culture', 'shopping'], months: [3, 4, 5, 10, 11], tint: 'from-fuchsia-400 via-violet-500 to-indigo-500' },
  { name: 'Seoul', iata: 'ICN', airport: 'Seoul Incheon (ICN)', country: 'South Korea', hook: 'Palaces, night markets and K-culture', days: 4, tags: ['food', 'shopping', 'culture'], months: [4, 5, 9, 10, 11], tint: 'from-sky-400 via-indigo-500 to-fuchsia-500' },
  { name: 'Baku', iata: 'GYD', airport: 'Baku (GYD)', country: 'Azerbaijan', hook: 'A walled old city on the Caspian', days: 3, tags: ['heritage', 'culture', 'food'], months: [4, 5, 6, 9, 10], tint: 'from-sky-400 via-blue-500 to-indigo-600' },
  { name: 'Tbilisi', iata: 'TBS', airport: 'Tbilisi (TBS)', country: 'Georgia', hook: 'Sulphur baths, old balconies and supra feasts', days: 3, tags: ['food', 'culture', 'heritage'], months: [5, 6, 9, 10], tint: 'from-rose-400 via-red-500 to-amber-400' },
  { name: 'Almaty', iata: 'ALA', airport: 'Almaty (ALA)', country: 'Kazakhstan', hook: 'Mountain lakes and canyons near the city', days: 3, tags: ['nature', 'adventure', 'photography'], months: [5, 6, 7, 8, 9], tint: 'from-teal-400 via-sky-500 to-blue-600' },
  { name: 'Paris', iata: 'CDG', airport: 'Paris (CDG)', country: 'France', hook: 'Museums, cafés and walks along the Seine', days: 4, tags: ['culture', 'food', 'romance'], months: [4, 5, 6, 9, 10], tint: 'from-sky-300 via-indigo-400 to-rose-400' },
  { name: 'London', iata: 'LHR', airport: 'London Heathrow (LHR)', country: 'United Kingdom', hook: 'Royal parks, free museums and the Thames', days: 4, tags: ['culture', 'shopping', 'heritage'], months: [5, 6, 7, 8, 9], tint: 'from-slate-400 via-sky-500 to-indigo-500' },
  { name: 'Interlaken', iata: 'ZRH', airport: 'Zurich (ZRH)', country: 'Switzerland', hook: 'Between two lakes, below the Jungfrau', days: 3, tags: ['nature', 'adventure', 'romance'], months: [6, 7, 8, 9, 12, 1, 2], tint: 'from-sky-300 via-cyan-400 to-emerald-400' },
  { name: 'Rome', iata: 'FCO', airport: 'Rome (FCO)', country: 'Italy', hook: 'Ancient ruins, piazzas and pasta', days: 4, tags: ['heritage', 'food', 'culture'], months: [4, 5, 6, 9, 10], tint: 'from-amber-400 via-orange-500 to-red-500' },
  { name: 'Barcelona', iata: 'BCN', airport: 'Barcelona (BCN)', country: 'Spain', hook: 'Gaudí buildings, beaches and tapas', days: 4, tags: ['culture', 'food', 'beaches'], months: [5, 6, 9, 10], tint: 'from-orange-400 via-rose-500 to-fuchsia-500' },
  { name: 'Prague', iata: 'PRG', airport: 'Prague (PRG)', country: 'Czechia', hook: 'Gothic spires and a castle above the river', days: 3, tags: ['heritage', 'culture', 'photography'], months: [4, 5, 6, 9, 10], tint: 'from-red-400 via-orange-400 to-amber-300' },
  { name: 'Amsterdam', iata: 'AMS', airport: 'Amsterdam (AMS)', country: 'Netherlands', hook: 'Canals, museums and bikes everywhere', days: 3, tags: ['culture', 'photography', 'food'], months: [4, 5, 6, 9], tint: 'from-orange-400 via-amber-400 to-sky-500' },
  { name: 'Cape Town', iata: 'CPT', airport: 'Cape Town (CPT)', country: 'South Africa', hook: 'Table Mountain, beaches and winelands', days: 5, tags: ['nature', 'food', 'adventure'], months: [11, 12, 1, 2, 3], tint: 'from-sky-400 via-teal-500 to-emerald-500' },
  { name: 'Sydney', iata: 'SYD', airport: 'Sydney (SYD)', country: 'Australia', hook: 'A harbour city of beaches and coastal walks', days: 5, tags: ['beaches', 'nature', 'food'], months: [9, 10, 11, 3, 4], tint: 'from-cyan-400 via-sky-500 to-blue-600' },
]

/** Interest chips (what the trip is about) and special requests (how to plan it). */
export const INTERESTS = {
  beaches: 'Beaches', food: 'Local food', nightlife: 'Nightlife', heritage: 'Heritage', shopping: 'Markets & shopping',
  romance: 'Romantic spots', photography: 'Photo spots', culture: 'Culture', spiritual: 'Spiritual sites',
  wellness: 'Wellness & yoga', adventure: 'Adventure', nature: 'Nature', relaxed: 'Slow travel', family: 'Kid-friendly',
}  // prettier-ignore
export const REQUESTS = [
  { id: 'veg', label: 'Vegetarian food', text: 'vegetarian food only' },
  { id: 'slow', label: 'Slow mornings', text: 'no early starts', pace: 'relaxed' },
  { id: 'packed', label: 'Pack it in', text: 'see as much as possible', pace: 'packed' },
  { id: 'budget', label: 'On a budget', text: 'keep costs low, prefer free sights' },
  { id: 'nodrive', label: 'Short hops', text: 'avoid long drives between stops' },
  { id: 'access', label: 'Step-free', text: 'step-free, accessible places where possible' },
]

export const PARTIES = [
  { id: 'solo', label: 'Just me', travellers: 1 },
  { id: 'couple', label: 'The two of us', travellers: 2 },
  { id: 'family', label: 'Family with kids', travellers: 4 },
  { id: 'friends', label: 'Friends', travellers: 4 },
]

/** Ways to narrow the list in the first step. */
export const FILTERS = [
  { id: 'all', label: 'Anywhere' },
  { id: 'india', label: 'India', test: (d) => d.country === 'India' },
  { id: 'abroad', label: 'Abroad', test: (d) => d.country !== 'India' },
  { id: 'beaches', label: 'Beaches', test: (d) => d.tags.includes('beaches') },
  { id: 'hills', label: 'Hills & nature', test: (d) => d.tags.includes('nature') },
  { id: 'heritage', label: 'Heritage', test: (d) => d.tags.includes('heritage') },
  { id: 'spiritual', label: 'Spiritual', test: (d) => d.tags.includes('spiritual') },
  { id: 'food', label: 'Food', test: (d) => d.tags.includes('food') },
]
export const filterPool = (id, pool = DESTINATIONS) => {
  const f = FILTERS.find((x) => x.id === id)
  return f?.test ? pool.filter(f.test) : pool
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
/** Places matching what's typed: name first, then state or country, then what it's known for. */
export function searchDestinations(text, pool = DESTINATIONS, n = 8) {
  const q = fold(text).trim()
  if (q.length < 2) return []
  const score = (d) => (fold(d.name).startsWith(q) ? 0 : fold(d.name).includes(q) ? 1 : fold(`${d.region ?? ''} ${d.country}`).includes(q) ? 2 : fold(`${d.hook} ${d.tags.join(' ')}`).includes(q) ? 3 : 9)
  return pool.map((d) => [score(d), d]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, d]) => d)
}

/** Small deterministic PRNG so "show me others" is stable in tests. */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** n destinations, in-season ones first (this month or next), shuffled by seed. */
export function suggestDestinations(month, seed = 1, n = 6, pool = DESTINATIONS) {
  const next = (month % 12) + 1
  const rand = rng(seed)
  const shuffle = (list) => list.map((d) => [rand(), d]).sort((a, b) => a[0] - b[0]).map(([, d]) => d)
  const inSeason = pool.filter((d) => d.months.includes(month) || d.months.includes(next))
  const rest = pool.filter((d) => !inSeason.includes(d))
  return [...shuffle(inSeason), ...shuffle(rest)].slice(0, n)
}

const pad = (n) => String(n).padStart(2, '0')
/** Local calendar date as YYYY-MM-DD (not toISOString, which is UTC). */
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const fmt = (d, withMonth) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', ...(withMonth ? { month: 'short' } : {}) })
export const rangeText = (start, days) => {
  const end = addDays(start, days - 1)
  return days === 1 ? fmt(start, true) : `${fmt(start, start.getMonth() !== end.getMonth())} – ${fmt(end, true)}`
}

/** One-tap date choices. Lengths follow the destination's comfortable stay (weekends are two days). */
export function whenOptions(today, idealDays) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const dow = t.getDay() // 0 Sun … 6 Sat
  const sat = addDays(t, (6 - dow + 7) % 7 || 7)
  const mon = addDays(t, (1 - dow + 7) % 7 || 7)
  const firstOfNext = new Date(t.getFullYear(), t.getMonth() + 1, 1)
  const nextMonthSat = addDays(firstOfNext, (6 - firstOfNext.getDay() + 7) % 7)
  const days = Math.min(Math.max(idealDays, 2), 10) // the planner plans up to 10 days
  return [
    { id: 'weekend', label: 'This weekend', start: sat, days: 2 },
    { id: 'next-week', label: 'Next week', start: mon, days },
    { id: 'in-two-weeks', label: 'In two weeks', start: addDays(mon, 7), days },
    { id: 'next-month', label: nextMonthSat.toLocaleDateString('en-GB', { month: 'long' }), start: nextMonthSat, days: Math.min(days + 1, 10) },
  ].map((o) => ({ ...o, range: rangeText(o.start, o.days) }))
}

/**
 * The request for the AI planner. Every choice is spelled out (explicit dates, party, pace) so the planner does not
 * have to guess. Stays within the API's 10–1000 character limit.
 */
export function composePrompt({ dest, when, party, interests = [], requests = [], note = '' }) {
  const p = PARTIES.find((x) => x.id === party) ?? PARTIES[1]
  const reqs = REQUESTS.filter((r) => requests.includes(r.id))
  const pace = reqs.find((r) => r.pace)?.pace ?? (interests.includes('relaxed') ? 'relaxed' : 'balanced')
  const end = addDays(when.start, when.days - 1)
  const where = [dest.name, dest.region, dest.country && dest.country !== dest.name ? dest.country : ''].filter(Boolean).join(', ')
  const who = { solo: 'travelling solo (1 traveller)', couple: 'for a couple (2 travellers)', family: 'for a family with kids (4 travellers)', friends: 'for a group of friends (4 travellers)' }[p.id]  // prettier-ignore
  const parts = [
    `${when.days} days in ${where}, from ${isoDate(when.start)} to ${isoDate(end)}, ${who}.`,
    interests.length ? `Interests: ${interests.map((i) => (INTERESTS[i] ?? i).toLowerCase()).join(', ')}.` : '',
    `Pace: ${pace}.`,
    reqs.length ? `Special requests: ${reqs.map((r) => r.text).join('; ')}.` : '',
    p.id === 'family' ? 'Keep it kid-friendly.' : '',
    note.trim() ? `Note from the traveller: ${note.trim().slice(0, 300)}` : '',
  ]
  return parts.filter(Boolean).join(' ').slice(0, 1000)
}

/** A destination typed by hand ("Somewhere else"): a city and, optionally, a country after a comma. */
export function customDestination(text) {
  const [name, country] = text.split(',').map((s) => s.trim())
  if (!name || name.length < 2) return null
  return { name: name.slice(0, 80), country: (country ?? '').slice(0, 60), hook: '', days: 3, tags: ['food', 'culture'], months: [], tint: 'from-slate-400 via-slate-500 to-slate-600' }
}

/** Known details (airport, booking codes) for a destination by name; {} for places typed by hand. */
export const destinationInfo = (name) => DESTINATIONS.find((d) => d.name.toLowerCase() === String(name ?? '').trim().toLowerCase()) ?? {}
