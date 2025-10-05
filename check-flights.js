const fetch = require('node-fetch');

// Configuration from environment variables
const CONFIG = {
    rapidApiKey: process.env.RAPIDAPI_KEY,
    emailUser: process.env.EMAIL_USER,
    emailPass: process.env.EMAIL_PASSWORD,
    recipientEmail: process.env.RECIPIENT_EMAIL
};

const preferences = {
    origin: 'DEL',
    destination: 'GOI',
    outboundDate: '2024-11-14',
    returnDate: '2024-11-18',
    maxBudget: 20000,
    refundablePremium: 2000,
    alertThreshold: 500
};

// Fetch flights from Kiwi.com API
async function fetchKiwiFlights() {
    try {
        console.log('Fetching from Kiwi.com...');
        const url = new URL('https://kiwi-com-cheap-flights.p.rapidapi.com/round-trip');
        url.searchParams.append('source', 'City:delhi_in');
        url.searchParams.append('destination', 'City:goa_in');
        url.searchParams.append('currency', 'inr');
        url.searchParams.append('departureDate', preferences.outboundDate);
        url.searchParams.append('returnDate', preferences.returnDate);
        url.searchParams.append('adults', '1');
        url.searchParams.append('children', '0');
        url.searchParams.append('infants', '0');
        url.searchParams.append('limit', '20');

        const response = await fetch(url, {
            headers: {
                'x-rapidapi-host': 'kiwi-com-cheap-flights.p.rapidapi.com',
                'x-rapidapi-key': CONFIG.rapidApiKey
            }
        });

        if (!response.ok) {
            throw new Error(`Kiwi API error: ${response.status}`);
        }

        const data = await response.json();
        console.log('Kiwi.com response received');
        return parseKiwiFlights(data);
    } catch (error) {
        console.error('Kiwi API Error:', error.message);
        return [];
    }
}

// Fetch flights from Google Flights API
async function fetchGoogleFlights() {
    try {
        console.log('Fetching from Google Flights...');
        const url = new URL('https://google-flights2.p.rapidapi.com/api/v1/searchFlights');
        url.searchParams.append('departure_id', 'DEL');
        url.searchParams.append('arrival_id', 'GOI');
        url.searchParams.append('outbound_date', preferences.outboundDate);
        url.searchParams.append('return_date', preferences.returnDate);
        url.searchParams.append('travel_class', 'ECONOMY');
        url.searchParams.append('adults', '1');
        url.searchParams.append('currency', 'INR');

        const response = await fetch(url, {
            headers: {
                'x-rapidapi-host': 'google-flights2.p.rapidapi.com',
                'x-rapidapi-key': CONFIG.rapidApiKey
            }
        });

        if (!response.ok) {
            throw new Error(`Google Flights API error: ${response.status}`);
        }

        const data = await response.json();
        console.log('Google Flights response received');
        return parseGoogleFlights(data);
    } catch (error) {
        console.error('Google Flights API Error:', error.message);
        return [];
    }
}

function parseKiwiFlights(data) {
    if (!data || !data.data) return [];
    
    return data.data.map((flight, idx) => {
        const outboundLeg = flight.route?.[0] || {};
        return {
            id: `kiwi-${idx}`,
            airline: outboundLeg.airline || 'Unknown',
            flightNumber: outboundLeg.flight_no || 'N/A',
            price: Math.round(flight.price || 0),
            refundable: false,
            outboundDate: new Date(outboundLeg.local_departure).toLocaleDateString('en-IN'),
            outboundTime: new Date(outboundLeg.local_departure).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
            source: 'Kiwi.com'
        };
    }).filter(f => f.price > 0 && f.price <= preferences.maxBudget);
}

function parseGoogleFlights(data) {
    if (!data || !data.data || !data.data.itineraries) return [];
    
    return data.data.itineraries.map((itinerary, idx) => {
        const outbound = itinerary.legs?.[0] || {};
        return {
            id: `google-${idx}`,
            airline: outbound.carriers?.[0]?.name || 'Unknown',
            flightNumber: outbound.carriers?.[0]?.iata_code || 'N/A',
            price: Math.round(itinerary.price?.amount || 0),
            refundable: itinerary.is_refundable || false,
            outboundDate: new Date(outbound.departure).toLocaleDateString('en-IN'),
            outboundTime: new Date(outbound.departure).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
            source: 'Google Flights'
        };
    }).filter(f => f.price > 0 && f.price <= preferences.maxBudget);
}

async function sendEmailAlert(flights) {
    if (!CONFIG.emailUser || !CONFIG.emailPass) {
        console.log('Email credentials not configured, skipping email...');
        return;
    }

    try {
        const nodemailer = require('nodemailer');
        
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: CONFIG.emailUser,
                pass: CONFIG.emailPass
            }
        });

        const cheapestFlight = flights[0];
        const topFlights = flights.slice(0, 5).map(f => 
            `• ${f.airline} ${f.flightNumber} - ₹${f.price} (${f.outboundDate} ${f.outboundTime}) [${f.source}]`
        ).join('\n');

        const mailOptions = {
            from: CONFIG.emailUser,
            to: CONFIG.recipientEmail,
            subject: `✈️ Flight Alert: Delhi→Goa - Cheapest ₹${cheapestFlight.price}`,
            text: `Flight Price Update - ${new Date().toLocaleString('en-IN')}

🎯 CHEAPEST FLIGHT: ₹${cheapestFlight.price}
${cheapestFlight.airline} ${cheapestFlight.flightNumber}
Departure: ${cheapestFlight.outboundDate} ${cheapestFlight.outboundTime}
Source: ${cheapestFlight.source}

📊 TOP 5 FLIGHTS:
${topFlights}

💰 Budget: ₹${preferences.maxBudget}
📅 Travel: ${preferences.outboundDate} to ${preferences.returnDate}

Total flights found: ${flights.length}

---
Automated by GitHub Actions Flight Tracker
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('✅ Email alert sent successfully!');
    } catch (error) {
        console.error('❌ Error sending email:', error.message);
    }
}

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('🛫 Flight Tracker Started');
    console.log('📅 Time:', new Date().toLocaleString('en-IN'));
    console.log('═══════════════════════════════════════════\n');
    
    // Fetch from both APIs
    const [kiwiFlights, googleFlights] = await Promise.all([
        fetchKiwiFlights(),
        fetchGoogleFlights()
    ]);

    // Combine and sort
    const allFlights = [...kiwiFlights, ...googleFlights]
        .sort((a, b) => a.price - b.price);

    console.log(`\n📊 Results:`);
    console.log(`   Kiwi.com: ${kiwiFlights.length} flights`);
    console.log(`   Google Flights: ${googleFlights.length} flights`);
    console.log(`   Total within budget: ${allFlights.length} flights\n`);

    if (allFlights.length > 0) {
        const cheapest = allFlights[0];
        console.log('💰 CHEAPEST FLIGHT:');
        console.log(`   ${cheapest.airline} ${cheapest.flightNumber}`);
        console.log(`   Price: ₹${cheapest.price}`);
        console.log(`   Date: ${cheapest.outboundDate} ${cheapest.outboundTime}`);
        console.log(`   Source: ${cheapest.source}\n`);

        // Check for refundable options
        const refundableFlights = allFlights.filter(f => f.refundable);
        if (refundableFlights.length > 0) {
            console.log(`✅ Found ${refundableFlights.length} refundable options\n`);
        }

        // Send email if price is good
        if (cheapest.price <= 12000) {
            console.log('🔔 ALERT: Great price detected! Sending email...\n');
            await sendEmailAlert(allFlights);
        } else {
            console.log('📧 No alert triggered (price above threshold)\n');
        }

        // Display top 5
        console.log('🏆 TOP 5 FLIGHTS:');
        allFlights.slice(0, 5).forEach((f, i) => {
            console.log(`   ${i + 1}. ${f.airline} - ₹${f.price} [${f.source}]`);
        });
    } else {
        console.log('❌ No flights found within budget\n');
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('✅ Check Complete!');
    console.log('═══════════════════════════════════════════');
}

main().catch(error => {
    console.error('❌ Fatal Error:', error);
    process.exit(1);
});