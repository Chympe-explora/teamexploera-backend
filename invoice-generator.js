/**
 * invoice-generator.js
 * -----------------------------------------------------------------------
 * Generate invoices and booking documents
 * 
 * Generates:
 * 1. Invoice PDF - booking details, cost breakdown, payment receipt
 * 2. Itinerary - tour schedule, what to bring, meeting point
 * 3. Packing List - gear and supplies needed
 * 
 * Uses simple HTML-to-PDF approach (via backend or frontend)
 * -----------------------------------------------------------------------
 */

/**
 * Generate invoice HTML (can be converted to PDF by frontend or backend)
 */
export function generateInvoiceHTML(booking, bookingId) {
  const {
    siteId = "krem-chympe",
    data = {},
    paymentStatus = "pending",
    createdAt = Date.now(),
  } = booking;

  const date = data.date || data.startDate || "TBD";
  const endDate = data.endDate || date;
  const travelers = data.travelers || 1;
  const totalCost = data.totalCost || data.price || 0;
  const gst = data.gst || 0;
  const finalCost = totalCost + gst;

  const packageNames = {
    "krem-chympe:sharedTour": "Krem Chympe - Shared Tour",
    "krem-chympe:privatePackage": "Krem Chympe - Private Package",
    "wilderness-expedition:sharedTour": "Wilderness Expedition - Shared Tour",
    "wilderness-expedition:privatePackage": "Wilderness Expedition - Private Package",
  };

  const packageName = packageNames[`${siteId}:${data.pkg}`] || "Tour Package";
  const bookingDateStr = new Date(createdAt).toLocaleDateString();
  const tourDateStr = new Date(date).toLocaleDateString();
  const tourEndDateStr = new Date(endDate).toLocaleDateString();

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Invoice - Team Explo Era</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #f5f5f5; }
        .container { max-width: 800px; margin: 20px auto; background: white; padding: 40px; }
        .header { text-align: center; margin-bottom: 40px; border-bottom: 2px solid #333; padding-bottom: 20px; }
        .logo { font-size: 24px; font-weight: bold; color: #333; margin-bottom: 5px; }
        .tagline { color: #666; font-size: 12px; }
        .invoice-title { font-size: 20px; font-weight: bold; margin-top: 20px; }
        
        .details { display: flex; justify-content: space-between; margin: 30px 0; }
        .details-col { width: 48%; }
        .details-col h4 { font-size: 12px; color: #999; text-transform: uppercase; margin-bottom: 5px; }
        .details-col p { font-size: 14px; margin-bottom: 3px; }
        
        .items { width: 100%; margin: 30px 0; }
        .items table { width: 100%; border-collapse: collapse; }
        .items th { background: #f5f5f5; padding: 10px; text-align: left; font-weight: bold; border-bottom: 1px solid #ddd; font-size: 12px; }
        .items td { padding: 12px 10px; border-bottom: 1px solid #eee; font-size: 14px; }
        
        .totals { margin: 30px 0; }
        .total-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
        .total-row.final { border-bottom: 2px solid #333; font-weight: bold; font-size: 16px; margin-top: 10px; }
        
        .status { padding: 10px; border-radius: 4px; margin: 20px 0; text-align: center; font-weight: bold; }
        .status.completed { background: #d4edda; color: #155724; }
        .status.pending { background: #fff3cd; color: #856404; }
        
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
        .footer p { margin-bottom: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">TEAM EXPLO ERA</div>
          <div class="tagline">Adventure Era Awaits</div>
          <div class="invoice-title">INVOICE</div>
        </div>
        
        <div class="details">
          <div class="details-col">
            <h4>Invoice To</h4>
            <p><strong>${data.name || "Guest"}</strong></p>
            <p>Phone: ${data.phone || "N/A"}</p>
            <p>Email: ${data.email || "N/A"}</p>
          </div>
          <div class="details-col">
            <h4>Invoice Details</h4>
            <p><strong>Booking ID:</strong> ${bookingId}</p>
            <p><strong>Booking Date:</strong> ${bookingDateStr}</p>
            <p><strong>Tour Date:</strong> ${tourDateStr} to ${tourEndDateStr}</p>
          </div>
        </div>
        
        <div class="items">
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Quantity</th>
                <th>Unit Price</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${packageName}</td>
                <td>${travelers}</td>
                <td>₹${(totalCost / travelers).toFixed(2)}</td>
                <td>₹${totalCost.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        
        <div class="totals">
          <div class="total-row">
            <span>Subtotal:</span>
            <span>₹${totalCost.toFixed(2)}</span>
          </div>
          <div class="total-row">
            <span>GST (18%):</span>
            <span>₹${gst.toFixed(2)}</span>
          </div>
          <div class="total-row final">
            <span>Total Amount:</span>
            <span>₹${finalCost.toFixed(2)}</span>
          </div>
        </div>
        
        <div class="status ${paymentStatus}">
          Payment Status: ${paymentStatus === "completed" ? "✓ PAID" : "PENDING"}
        </div>
        
        <div class="footer">
          <p><strong>Important Information:</strong></p>
          <p>• Please arrive 15 minutes before the scheduled tour time</p>
          <p>• Bring valid ID and appropriate clothing</p>
          <p>• Check weather conditions before the tour</p>
          <p>• Contact us for any changes or cancellations</p>
          <p style="margin-top: 15px; text-align: center; color: #999;">Thank you for booking with Team Explo Era!</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate itinerary HTML
 */
export function generateItineraryHTML(booking, siteId) {
  const { data = {} } = booking;
  const date = data.date || data.startDate || "TBD";
  const endDate = data.endDate || date;

  const itineraries = {
    "krem-chympe": {
      title: "Krem Chympe Adventure - Itinerary",
      location: "East Jaintia Hills, Meghalaya",
      duration: "1 Day",
      meetingPoint: "Krem Chympe Visitor Center, Meghalaya",
      meetingTime: "7:00 AM",
      activities: [
        "6:30 AM - Meet at visitor center, briefing",
        "7:30 AM - Trek to Krem Chympe cave entrance",
        "9:00 AM - Cave exploration with guide",
        "12:00 PM - Lunch at base camp",
        "1:00 PM - Water activities in cave pools",
        "3:00 PM - Return trek",
        "5:00 PM - End of tour",
      ],
    },
    "wilderness-expedition": {
      title: "Wilderness Expedition - 6 Day Itinerary",
      location: "Meghalaya Deep Wilderness",
      duration: "6 Days",
      meetingPoint: "Main Camp Base, Meghalaya",
      meetingTime: "6:00 AM (Day 1)",
      activities: [
        "Day 1: Base camp setup, orientation, evening camp activities",
        "Day 2: Trek to water source, river crossing training",
        "Day 3: Wilderness navigation, survival skills",
        "Day 4: Advanced cave exploration",
        "Day 5: Final trek, cultural interaction",
        "Day 6: Early departure with breakfast",
      ],
    },
  };

  const itinerary = itineraries[siteId] || itineraries["krem-chympe"];

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Itinerary - Team Explo Era</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #f5f5f5; }
        .container { max-width: 800px; margin: 20px auto; background: white; padding: 40px; }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: bold; color: #333; margin-bottom: 10px; }
        .title { font-size: 22px; font-weight: bold; margin: 20px 0; }
        
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }
        .info-box { padding: 15px; background: #f9f9f9; border-left: 4px solid #333; }
        .info-box h4 { font-size: 12px; color: #999; text-transform: uppercase; margin-bottom: 5px; }
        .info-box p { font-size: 14px; color: #333; }
        
        .schedule { margin: 30px 0; }
        .schedule h3 { font-size: 16px; font-weight: bold; margin-bottom: 15px; }
        .activity { padding: 12px; margin: 8px 0; background: #f9f9f9; border-left: 4px solid #666; }
        .activity p { font-size: 14px; color: #333; }
        
        .packing { margin: 30px 0; }
        .packing h3 { font-size: 16px; font-weight: bold; margin: 20px 0 15px 0; }
        .packing-list { columns: 2; column-gap: 30px; }
        .packing-list li { margin-bottom: 8px; font-size: 13px; }
        
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">TEAM EXPLO ERA</div>
          <h1 class="title">${itinerary.title}</h1>
        </div>
        
        <div class="info-grid">
          <div class="info-box">
            <h4>Location</h4>
            <p>${itinerary.location}</p>
          </div>
          <div class="info-box">
            <h4>Duration</h4>
            <p>${itinerary.duration}</p>
          </div>
          <div class="info-box">
            <h4>Meeting Point</h4>
            <p>${itinerary.meetingPoint}</p>
          </div>
          <div class="info-box">
            <h4>Meeting Time</h4>
            <p>${itinerary.meetingTime}</p>
          </div>
        </div>
        
        <div class="schedule">
          <h3>Daily Schedule</h3>
          ${itinerary.activities.map((activity) => `<div class="activity"><p>${activity}</p></div>`).join("")}
        </div>
        
        <div class="packing">
          <h3>What to Bring</h3>
          <ul class="packing-list">
            <li>Comfortable trekking shoes</li>
            <li>Weather-appropriate clothing</li>
            <li>Water bottle (1.5L minimum)</li>
            <li>Sun protection (hat, sunscreen)</li>
            <li>Light jacket or rain coat</li>
            <li>Torch or headlamp</li>
            <li>Personal medications</li>
            <li>Snacks and energy bars</li>
            <li>Camera (optional)</li>
            <li>Mobile phone & charger</li>
            <li>Personal hygiene items</li>
            <li>Any required ID proof</li>
          </ul>
        </div>
        
        <div class="footer">
          <p><strong>Emergency Contact:</strong> Your guide will have a satellite phone for emergencies.</p>
          <p style="margin-top: 10px;">For any questions, contact us before the tour date.</p>
          <p style="margin-top: 15px; text-align: center; color: #999;">Have an amazing adventure with Team Explo Era!</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate packing list HTML
 */
export function generatePackingListHTML() {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Packing List - Team Explo Era</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #f5f5f5; }
        .container { max-width: 600px; margin: 20px auto; background: white; padding: 40px; }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
        .title { font-size: 20px; font-weight: bold; margin: 20px 0; }
        
        .category { margin: 25px 0; }
        .category h3 { font-size: 14px; font-weight: bold; background: #f0f0f0; padding: 10px; margin-bottom: 10px; }
        .category ul { list-style: none; }
        .category li { padding: 8px 15px; border-bottom: 1px solid #eee; font-size: 13px; }
        .category li:before { content: "☐ "; margin-right: 10px; }
        
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; text-align: center; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">TEAM EXPLO ERA</div>
          <h1 class="title">Complete Packing List</h1>
        </div>
        
        <div class="category">
          <h3>Footwear & Clothing</h3>
          <ul>
            <li>Trekking shoes (well-broken-in)</li>
            <li>Comfortable t-shirts (2-3)</li>
            <li>Hiking pants or shorts</li>
            <li>Warm jacket or fleece</li>
            <li>Rain jacket or poncho</li>
            <li>Socks (wool, moisture-wicking)</li>
            <li>Underwear</li>
            <li>Hat or cap</li>
            <li>Bandana or neck gaiter</li>
          </ul>
        </div>
        
        <div class="category">
          <h3>Safety & Navigation</h3>
          <ul>
            <li>Torch or headlamp with batteries</li>
            <li>Whistle</li>
            <li>First aid kit (personal)</li>
            <li>Sunscreen (SPF 50+)</li>
            <li>Insect repellent</li>
            <li>Any personal medications</li>
          </ul>
        </div>
        
        <div class="category">
          <h3>Hydration & Nutrition</h3>
          <ul>
            <li>Water bottle (1.5L capacity)</li>
            <li>Energy bars or snacks</li>
            <li>Electrolyte powder</li>
            <li>Chocolate or quick energy food</li>
          </ul>
        </div>
        
        <div class="category">
          <h3>Electronics & Documents</h3>
          <ul>
            <li>Mobile phone & charger</li>
            <li>Power bank (10000mAh+)</li>
            <li>ID proof (Aadhar/Passport)</li>
            <li>Insurance copy (if any)</li>
            <li>Booking confirmation</li>
            <li>Camera (optional)</li>
          </ul>
        </div>
        
        <div class="category">
          <h3>Personal Care & Hygiene</h3>
          <ul>
            <li>Toothbrush & toothpaste</li>
            <li>Soap & shampoo (travel size)</li>
            <li>Deodorant</li>
            <li>Wet wipes</li>
            <li>Toilet paper & tissue</li>
            <li>Feminine hygiene products (if needed)</li>
            <li>Lip balm</li>
          </ul>
        </div>
        
        <div class="category">
          <h3>Miscellaneous</h3>
          <ul>
            <li>Backpack (40-50L)</li>
            <li>Sleeping bag (if overnight tour)</li>
            <li>Travel pillow</li>
            <li>Watch or timer</li>
            <li>Rope or paracord</li>
            <li>Zip-lock bags (various sizes)</li>
            <li>Duct tape roll</li>
            <li>Multi-tool or knife</li>
          </ul>
        </div>
        
        <div class="footer">
          <p><strong>Tips:</strong> Pack light, use compression bags, wear layered clothing</p>
          <p style="margin-top: 10px;">Print this list and check items as you pack!</p>
        </div>
      </div>
    </body>
    </html>
  `;
}
