const fetch = require('node-fetch');
const fs = require('fs');

// Configuration from environment variables
const CONFIG = {
    amadeusApiKey: process.env.AMADEUS_API_KEY,
    amadeusApiSecret: process.env.AMADEUS_API_SECRET,
    emailUser: process.env.EMAIL_USER,
    emailPass: process.env.EMAIL_PASSWORD,
    recipientEmail: process.env.RECIPIENT_EMAIL
};

const FLIGHT_CONFIG = {
    origin: 'DEL',
    destination: 'GOI',
    outboundDate: '2024-11-14',
    returnDate: '2024-11-18',
    departureTimeStart: '18:00',
    returnTimeStart: '12:00',
    returnTimeEnd: '17:00',
    adults: 1,
    maxStops: 1,
    excludedAirlines: ['I5', 'AK'], // Air India Express, AirAsia
    priceDropThreshold: 300,
    refundableMarkup: 0.15 // 15% markup estimate for refundable
};

const PRICE_HISTORY_FILE = 'price-history.json';

// Get Amadeus Access Token
async function getAmadeusToken() {
    try {
        const response = await fetch('https://test.api.amadeus.com/v1/security/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `grant_type=client_credentials&client_id=${CONFIG.amadeusApiKey}&client_secret=${CONFIG.amadeusApiSecret}`
        });

        const data = await response.json();
        return data.access_token;
    } catch (error) {
        console.error('Error getting Amadeus token:', error.message);
        throw error;
    }
}

// Search flights using Amadeus API
async function searchFlights(token) {
    try {
        const url = new URL('https://test.api.amadeus.com/v2/shopping/flight-offers');
        url.searchParams.append('originLocationCode', FLIGHT_CONFIG.origin);
        url.searchParams.append('destinationLocationCode', FLIGHT_CONFIG.destination);
        url.searchParams.append('departureDate', FLIGHT_CONFIG.outboundDate);
        url.searchParams.append('returnDate', FLIGHT_CONFIG.returnDate);
        url.searchParams.append('adults', FLIGHT_CONFIG.adults);
        url.searchParams.append('currencyCode', 'INR');
        url.searchParams.append('max', '50');

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Amadeus API error: ${response.status}`);
        }

        const data = await response.json();
        return parseAmadeusFlights(data);
    } catch (error) {
        console.error('Error fetching flights:', error.message);
        return [];
    }
}

// Parse Amadeus flight response
function parseAmadeusFlights(data) {
    if (!data || !data.data) return [];

    const flights = data.data.map(offer => {
        const outbound = offer.itineraries[0];
        const returnFlight = offer.itineraries[1];
        const price = parseFloat(offer.price.total);
        
        // Get airline from first segment
        const airlineCode = outbound.segments[0].carrierCode;
        const airlineName = getAirlineName(airlineCode);
        
        // Check if excluded
        if (FLIGHT_CONFIG.excludedAirlines.includes(airlineCode)) {
            return null;
        }

        // Get flight details
        const outboundDeparture = outbound.segments[0].departure.at;
        const outboundArrival = outbound.segments[outbound.segments.length - 1].arrival.at;
        const outboundDuration = outbound.duration;
        const outboundStops = outbound.segments.length - 1;

        const returnDeparture = returnFlight.segments[0].departure.at;
        const returnArrival = returnFlight.segments[returnFlight.segments.length - 1].arrival.at;
        const returnDuration = returnFlight.duration;
        const returnStops = returnFlight.segments.length - 1;

        // Check outbound time constraint (after 6 PM)
        const depTime = new Date(outboundDeparture).getHours();
        if (depTime < 18) return null;

        // Check return time constraint (12 PM - 5 PM)
        const retTime = new Date(returnDeparture).getHours();
        if (retTime < 12 || retTime >= 17) return null;

        // Check stops
        if (outboundStops > FLIGHT_CONFIG.maxStops || returnStops > FLIGHT_CONFIG.maxStops) {
            return null;
        }

        return {
            id: offer.id,
            airline: airlineName,
            airlineCode: airlineCode,
            price: Math.round(price),
            refundablePrice: Math.round(price * (1 + FLIGHT_CONFIG.refundableMarkup)),
            outbound: {
                departure: formatDateTime(outboundDeparture),
                arrival: formatDateTime(outboundArrival),
                duration: formatDuration(outboundDuration),
                stops: outboundStops
            },
            return: {
                departure: formatDateTime(returnDeparture),
                arrival: formatDateTime(returnArrival),
                duration: formatDuration(returnDuration),
                stops: returnStops
            },
            totalDuration: parseDuration(outboundDuration) + parseDuration(returnDuration)
        };
    }).filter(f => f !== null);

    return flights;
}

function getAirlineName(code) {
    const airlines = {
        '6E': 'IndiGo',
        'UK': 'Vistara',
        'SG': 'SpiceJet',
        'AI': 'Air India',
        'I5': 'Air India Express',
        'AK': 'AirAsia',
        'G8': 'Go First'
    };
    return airlines[code] || code;
}

function formatDateTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short'
    });
}

function formatDuration(isoDuration) {
    const match = isoDuration.match(/PT(\d+H)?(\d+M)?/);
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2]) : 0;
    return `${hours}h ${minutes}m`;
}

function parseDuration(isoDuration) {
    const match = isoDuration.match(/PT(\d+H)?(\d+M)?/);
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2]) : 0;
    return hours * 60 + minutes;
}

// Categorize flights
function categorizeFlights(flights) {
    if (flights.length === 0) return null;

    // Fastest flight (direct preferred)
    const directFlights = flights.filter(f => f.outbound.stops === 0);
    const fastest = directFlights.length > 0 
        ? directFlights.reduce((min, f) => f.totalDuration < min.totalDuration ? f : min)
        : flights.reduce((min, f) => f.totalDuration < min.totalDuration ? f : min);

    // Cheapest flight
    const cheapest = flights.reduce((min, f) => f.price < min.price ? f : min);

    // Best 1-stop option
    const oneStopFlights = flights.filter(f => f.outbound.stops === 1 || f.return.stops === 1);
    const bestOneStop = oneStopFlights.length > 0
        ? oneStopFlights.reduce((min, f) => f.price < min.price ? f : min)
        : null;

    return { fastest, cheapest, bestOneStop };
}

// Load price history
function loadPriceHistory() {
    try {
        if (fs.existsSync(PRICE_HISTORY_FILE)) {
            const data = fs.readFileSync(PRICE_HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading price history:', error.message);
    }
    return { daily: [], lastCheck: null };
}

// Save price history
function savePriceHistory(history) {
    try {
        fs.writeFileSync(PRICE_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (error) {
        console.error('Error saving price history:', error.message);
    }
}

// Check if it's 10 AM
function is10AM() {
    const now = new Date();
    return now.getHours() === 10 && now.getMinutes() < 60;
}

// Get today's date string
function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

// Send email
async function sendEmail(subject, htmlContent) {
    if (!CONFIG.emailUser || !CONFIG.emailPass) {
        console.log('Email not configured, skipping...');
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

        await transporter.sendMail({
            from: CONFIG.emailUser,
            to: CONFIG.recipientEmail,
            subject: subject,
            html: htmlContent
        });

        console.log('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error.message);
    }
}

// Generate daily summary email
function generateDailySummaryEmail(categories, history) {
    const { fastest, cheapest, bestOneStop } = categories;
    
    const today = getTodayString();
    const todayHistory = history.daily.find(d => d.date === today);
    const yesterdayHistory = history.daily[history.daily.length - 2];

    let html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
        .container { max-width: 700px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; }
        .header p { margin: 10px 0 0 0; opacity: 0.9; }
        .section { padding: 25px; border-bottom: 1px solid #eee; }
        .section:last-child { border-bottom: none; }
        .section-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; color: #333; }
        .flight-card { background: #f9f9f9; border-left: 4px solid #667eea; padding: 15px; margin-bottom: 15px; border-radius: 5px; }
        .airline { font-size: 16px; font-weight: bold; color: #333; margin-bottom: 8px; }
        .flight-details { color: #666; font-size: 14px; margin: 5px 0; }
        .price-box { background: white; padding: 10px; border-radius: 5px; margin-top: 10px; }
        .price { font-size: 20px; font-weight: bold; color: #667eea; }
        .price-label { font-size: 12px; color: #888; }
        .alert-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; border-radius: 5px; }
        .stats { display: flex; justify-content: space-around; background: #f0f4ff; padding: 15px; border-radius: 5px; }
        .stat { text-align: center; }
        .stat-value { font-size: 20px; font-weight: bold; color: #667eea; }
        .stat-label { font-size: 12px; color: #666; margin-top: 5px; }
        .footer { padding: 20px; text-align: center; color: #888; font-size: 12px; background: #f9f9f9; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Daily Flight Update</h1>
            <p>Delhi to Goa | 14 Nov 2024 (6PM onwards)</p>
            <p>${new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' })}</p>
        </div>

        <div class="section">
            <div class="section-title">Fastest Flight</div>
            <div class="flight-card">
                <div class="airline">${fastest.airline} ${fastest.airlineCode}</div>
                <div class="flight-details">
                    <strong>Outbound:</strong> ${fastest.outbound.departure} to ${fastest.outbound.arrival} (${fastest.outbound.duration}, ${fastest.outbound.stops === 0 ? 'Non-stop' : `${fastest.outbound.stops} stop`})
                </div>
                <div class="flight-details">
                    <strong>Return:</strong> ${fastest.return.departure} to ${fastest.return.arrival} (${fastest.return.duration}, ${fastest.return.stops === 0 ? 'Non-stop' : `${fastest.return.stops} stop`})
                </div>
                <div class="price-box">
                    <div class="price">Rs ${fastest.price.toLocaleString('en-IN')}</div>
                    <div class="price-label">Non-Refundable</div>
                </div>
                <div class="price-box">
                    <div class="price">Rs ${fastest.refundablePrice.toLocaleString('en-IN')}</div>
                    <div class="price-label">Refundable (Est.) - Rs ${(fastest.refundablePrice - fastest.price).toLocaleString('en-IN')} more</div>
                </div>
            </div>
        </div>

        <div class="section">
            <div class="section-title">Cheapest Flight</div>
            <div class="flight-card">
                <div class="airline">${cheapest.airline} ${cheapest.airlineCode}</div>
                <div class="flight-details">
                    <strong>Outbound:</strong> ${cheapest.outbound.departure} to ${cheapest.outbound.arrival} (${cheapest.outbound.duration}, ${cheapest.outbound.stops === 0 ? 'Non-stop' : `${cheapest.outbound.stops} stop`})
                </div>
                <div class="flight-details">
                    <strong>Return:</strong> ${cheapest.return.departure} to ${cheapest.return.arrival} (${cheapest.return.duration}, ${cheapest.return.stops === 0 ? 'Non-stop' : `${cheapest.return.stops} stop`})
                </div>
                <div class="price-box">
                    <div class="price">Rs ${cheapest.price.toLocaleString('en-IN')}</div>
                    <div class="price-label">Non-Refundable</div>
                </div>
                <div class="price-box">
                    <div class="price">Rs ${cheapest.refundablePrice.toLocaleString('en-IN')}</div>
                    <div class="price-label">Refundable (Est.) - Rs ${(cheapest.refundablePrice - cheapest.price).toLocaleString('en-IN')} more</div>
                </div>
            </div>
        </div>

        ${bestOneStop ? `
        <div class="section">
            <div class="section-title">Best 1-Stop Option</div>
            <div class="flight-card">
                <div class="airline">${bestOneStop.airline} ${bestOneStop.airlineCode}</div>
                <div class="flight-details">
                    <strong>Outbound:</strong> ${bestOneStop.outbound.departure} to ${bestOneStop.outbound.arrival} (${bestOneStop.outbound.duration}, ${bestOneStop.outbound.stops} stop)
                </div>
                <div class="flight-details">
                    <strong>Return:</strong> ${bestOneStop.return.departure} to ${bestOneStop.return.arrival} (${bestOneStop.return.duration}, ${bestOneStop.return.stops === 0 ? 'Non-stop' : `${bestOneStop.return.stops} stop`})
                </div>
                <div class="price-box">
                    <div class="price">Rs ${bestOneStop.price.toLocaleString('en-IN')}</div>
                    <div class="price-label">Non-Refundable</div>
                </div>
                <div class="price-box">
                    <div class="price">Rs ${bestOneStop.refundablePrice.toLocaleString('en-IN')}</div>
                    <div class="price-label">Refundable (Est.) - Rs ${(bestOneStop.refundablePrice - bestOneStop.price).toLocaleString('en-IN')} more</div>
                </div>
            </div>
        </div>
        ` : ''}

        <div class="section">
            <div class="section-title">Price Tracking</div>
            <div class="stats">
                <div class="stat">
                    <div class="stat-value">Rs ${fastest.price.toLocaleString('en-IN')}</div>
                    <div class="stat-label">Fastest</div>
                </div>
                <div class="stat">
                    <div class="stat-value">Rs ${cheapest.price.toLocaleString('en-IN')}</div>
                    <div class="stat-label">Cheapest</div>
                </div>
                ${bestOneStop ? `
                <div class="stat">
                    <div class="stat-value">Rs ${bestOneStop.price.toLocaleString('en-IN')}</div>
                    <div class="stat-label">Best 1-Stop</div>
                </div>
                ` : ''}
            </div>
            
            <div class="alert-box">
                <strong>Alert Threshold: Rs ${FLIGHT_CONFIG.priceDropThreshold} drop</strong><br>
                You will be notified if prices drop below:<br>
                Fastest: Rs ${(fastest.price - FLIGHT_CONFIG.priceDropThreshold).toLocaleString('en-IN')}<br>
                Cheapest: Rs ${(cheapest.price - FLIGHT_CONFIG.priceDropThreshold).toLocaleString('en-IN')}
                ${bestOneStop ? `<br>Best 1-Stop: Rs ${(bestOneStop.price - FLIGHT_CONFIG.priceDropThreshold).toLocaleString('en-IN')}` : ''}
            </div>
        </div>

        <div class="footer">
            Next check: ${new Date(Date.now() + 3600000).toLocaleTimeString('en-IN')}<br>
            Powered by Amadeus API | GitHub Actions
        </div>
    </div>
</body>
</html>`;

    return html;
}

// Generate price drop alert email
function generatePriceDropEmail(category, flight, oldPrice, newPrice) {
    const drop = oldPrice - newPrice;
    
    let html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; }
        .drop-amount { font-size: 36px; font-weight: bold; margin: 15px 0; }
        .section { padding: 25px; }
        .flight-card { background: #f9f9f9; border-left: 4px solid #f5576c; padding: 15px; margin: 15px 0; border-radius: 5px; }
        .airline { font-size: 18px; font-weight: bold; color: #333; margin-bottom: 10px; }
        .flight-details { color: #666; font-size: 14px; margin: 5px 0; }
        .price-comparison { display: flex; justify-content: space-around; margin: 20px 0; }
        .price-item { text-align: center; }
        .old-price { text-decoration: line-through; color: #999; font-size: 16px; }
        .new-price { font-size: 24px; font-weight: bold; color: #f5576c; }
        .footer { padding: 20px; text-align: center; color: #888; font-size: 12px; background: #f9f9f9; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>PRICE DROP ALERT</h1>
            <div class="drop-amount">Down Rs ${drop.toLocaleString('en-IN')}</div>
            <p>${category.toUpperCase()} - ${new Date().toLocaleTimeString('en-IN')}</p>
        </div>

        <div class="section">
            <div class="flight-card">
                <div class="airline">${flight.airline} ${flight.airlineCode}</div>
                <div class="flight-details">
                    <strong>Outbound:</strong> ${flight.outbound.departure} to ${flight.outbound.arrival}<br>
                    ${flight.outbound.duration} - ${flight.outbound.stops === 0 ? 'Non-stop' : `${flight.outbound.stops} stop`}
                </div>
                <div class="flight-details">
                    <strong>Return:</strong> ${flight.return.departure} to ${flight.return.arrival}<br>
                    ${flight.return.duration} - ${flight.return.stops === 0 ? 'Non-stop' : `${flight.return.stops} stop`}
                </div>
            </div>

            <div class="price-comparison">
                <div class="price-item">
                    <div class="old-price">Rs ${oldPrice.toLocaleString('en-IN')}</div>
                    <div style="font-size: 12px; color: #888;">Previous Low</div>
                </div>
                <div class="price-item">
                    <div class="new-price">Rs ${newPrice.toLocaleString('en-IN')}</div>
                    <div style="font-size: 12px; color: #888;">Current Price</div>
                </div>
            </div>

            <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin-top: 20px;">
                <strong>Pricing Options</strong><br>
                Non-Refundable: Rs ${flight.price.toLocaleString('en-IN')}<br>
                Refundable (Est.): Rs ${flight.refundablePrice.toLocaleString('en-IN')}
            </div>
        </div>

        <div class="footer">
            Automated by Flight Tracker | GitHub Actions
        </div>
    </div>
</body>
</html>`;

    return html;
}

// Main function
async function main() {
    console.log('Flight Tracker Started');
    console.log('Time:', new Date().toLocaleString('en-IN'));

    // Get Amadeus token
    console.log('Getting Amadeus access token...');
    const token = await getAmadeusToken();
    console.log('Token received');

    // Search flights
    console.log('Searching flights...');
    const flights = await searchFlights(token);
    console.log(`Found ${flights.length} flights matching criteria`);

    if (flights.length === 0) {
        console.log('No flights found');
        return;
    }

    // Categorize flights
    const categories = categorizeFlights(flights);
    
    if (!categories) {
        console.log('Could not categorize flights');
        return;
    }

    console.log('Fastest:', categories.fastest.airline, 'Rs' + categories.fastest.price);
    console.log('Cheapest:', categories.cheapest.airline, 'Rs' + categories.cheapest.price);
    if (categories.bestOneStop) {
        console.log('Best 1-Stop:', categories.bestOneStop.airline, 'Rs' + categories.bestOneStop.price);
    }

    // Load price history
    const history = loadPriceHistory();
    const today = getTodayString();
    let todayHistory = history.daily.find(d => d.date === today);

    if (!todayHistory) {
        todayHistory = {
            date: today,
            fastest: categories.fastest.price,
            cheapest: categories.cheapest.price,
            bestOneStop: categories.bestOneStop ? categories.bestOneStop.price : null
        };
        history.daily.push(todayHistory);
    }

    // Check if 10 AM - send daily summary
    if (is10AM()) {
        console.log('Sending 10 AM daily summary...');
        const emailHtml = generateDailySummaryEmail(categories, history);
        await sendEmail('Daily Flight Update - Delhi to Goa (14 Nov)', emailHtml);
        
        // Update today's baseline
        todayHistory.fastest = categories.fastest.price;
        todayHistory.cheapest = categories.cheapest.price;
        todayHistory.bestOneStop = categories.bestOneStop ? categories.bestOneStop.price : null;
    } else {
        // Check for price drops
        console.log('Checking for price drops...');
        
        const alerts = [];
        
        if (categories.fastest.price <= todayHistory.fastest - FLIGHT_CONFIG.priceDropThreshold) {
            alerts.push({
                category: 'Fastest Flight',
                flight: categories.fastest,
                oldPrice: todayHistory.fastest,
                newPrice: categories.fastest.price
            });
            todayHistory.fastest = categories.fastest.price;
        }
        
        if (categories.cheapest.price <= todayHistory.cheapest - FLIGHT_CONFIG.priceDropThreshold) {
            alerts.push({
                category: 'Cheapest Flight',
                flight: categories.cheapest,
                oldPrice: todayHistory.cheapest,
                newPrice: categories.cheapest.price
            });
            todayHistory.cheapest = categories.cheapest.price;
        }
        
        if (categories.bestOneStop && todayHistory.bestOneStop &&
            categories.bestOneStop.price <= todayHistory.bestOneStop - FLIGHT_CONFIG.priceDropThreshold) {
            alerts.push({
                category: 'Best 1-Stop',
                flight: categories.bestOneStop,
                oldPrice: todayHistory.bestOneStop,
                newPrice: categories.bestOneStop.price
            });
            todayHistory.bestOneStop = categories.bestOneStop.price;
        }
        
        if (alerts.length > 0) {
            console.log(`${alerts.length} price drop(s) detected`);
            for (const alert of alerts) {
                const emailHtml = generatePriceDropEmail(
                    alert.category,
                    alert.flight,
                    alert.oldPrice,
                    alert.newPrice
                );
                await sendEmail(
                    `PRICE DROP: ${alert.category} Down Rs ${alert.oldPrice - alert.newPrice}`,
                    emailHtml
                );
            }
        } else {
            console.log('No significant price drops');
        }
    }

    // Save updated history
    history.lastCheck = new Date().toISOString();
    savePriceHistory(history);

    console.log('Flight Check Complete');
}

main().catch(error => {
    console.error('Fatal Error:', error);
    process.exit(1);
});