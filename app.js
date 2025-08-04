const { default: axios } = require("axios");
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
var bodyParser = require('body-parser')
const io = new Server(server);
let socket = null;

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// parse application/json
app.use(bodyParser.json())

const baseUrl = "https://vipankumar.com/ecity/";

const users = new Map();



io.on("connection", (socketConn) => {
 console.log("connectedd");
 socket = socketConn;
 socket.on("connected", ({ providerId }) => {
    users.set(providerId, socket.id);
    io.to(socket.id).emit("connected", { providerId })
   console.log(users);
 });
 
 socket.on("get-requests", ({ providerId }) => {
   getPendingRequests(providerId);
 });
});

const getPendingRequests = async (merchant_id) => {
   const { data } = await axios.post(`${baseUrl}index.php/api/merchant/auth/get_request_status`, {
      merchantId: merchant_id
   }, {
      headers: {
         "authtoken": "development", // Replace with a secure way of handling authentication token
         "Accept-Language": "en",
      },
   });
   const requests = data?.record ?? [];
   const userSocketId = users.get(+merchant_id);
   io.to(userSocketId).emit("pending_requests", {requests})
}

const sendToRemainingMerchants = async (bookingId, merchantId) => {
try{

   const { data } = await axios.post(`${baseUrl}index.php/api/merchant/auth/get_merchant_id`, {
      merchantId: merchantId,
      booking_id: bookingId
   }, {
      headers: {
         "authtoken": "development", // Replace with a secure way of handling authentication token
         "Accept-Language": "en",
      },
   });
   const requests = data?.record ?? [];
   const merchants = requests.map(i => i.merchant_id);
   console.log({ merchants });     
   for(let merchant of merchants){
   	await getPendingRequests(merchant);
   }
   }catch(e){
   }
}

app.post("/send-request", async (req, res) => {
  try {
    const { category_id, sub_category_id, address, latitude, longitude, description, userId, datetime, booking_type } = req.body;

    if (!category_id || !sub_category_id || !address || !latitude || !longitude || !description || !userId || !datetime || !booking_type) {
      return res.status(400).json({
        status: 400,
        message: "Parameter missing",
        record: ["Some parameters missing - category_id, sub_category_id, address, latitude, longitude, description, userId, datetime, booking_type"]
      });
    }

    const formData = {
      category_id,
      sub_category_id,
      address,
      latitude,
      longitude,
      description,
      userId,
      datetime,
      booking_type,
    };

    const { data } = await axios.post(`${baseUrl}api/users/Auth/sendlocator`, formData, {
      headers: {
        "authtoken": "development", // Replace with a secure way of handling authentication token
        "Accept-Language": "en",
      },
    });

    sendToRemainingMerchants(data.booking_id, "");
    // Wait for 10 seconds before registering the next route
    setTimeout(async () => {
      var booking_id = data.booking_id;
      const statusFormData = {
        booking_id,
      };

      const statusResponse = await axios.post(`${baseUrl}api/users/Auth/getstatus`, statusFormData, {
        headers: {
          "authtoken": "development", 
          "Accept-Language": "en",
        },
      });

      console.log("Status:", statusResponse.data);
    }, 900000);

    var message = data.message;
     console.log("message:", message);
     var connectedId = data.UserID;
     console.log("userId:", connectedId);

     const userSocketId = users.get(+connectedId);
     console.log(connectedId, userSocketId);     
      io.to(userSocketId).emit("request_created", {message})

    return res.status(200).json(data);
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ status: 500, message: "Internal Server Error" });
  }
});


app.post("/accept-request", async (req, res) => {
  try {
    const { booking_id, locator_id, status, merchantId } = req.body;

    if (!booking_id || !locator_id || !status || !merchantId) {
      return res.status(400).json({
        status: 400,
        message: "Parameter missing",
        record: ["Some parameters missing - booking_id, locator_id, status, merchantId"]
      });
    }

    const formData = {
      booking_id,
      locator_id,
      status,
      merchantId,
    };

    const { data } = await axios.post(`${baseUrl}api/merchant/Auth/booking_status`, formData, {
      headers: {
        "authtoken": "development", // Replace with a secure way of handling authentication token
        "Accept-Language": "en",
      },
    });

     var message = data.message;
     console.log("message:", message);
     var bookingId = data.booking_id;
     console.log("bookingId:", bookingId);
     var connectedId = data.UserID;
     console.log("userId:", connectedId);

     const userSocketId = users.get(+connectedId);
     console.log(connectedId, userSocketId);
     if(message == 'Accept'){      
      io.to(userSocketId).emit("request-accepted", { bookingId })
      sendToRemainingMerchants(bookingId, merchantId);
     }else{
      io.to(userSocketId).emit("request-rejected", { bookingId })
     }
     

    console.log(data);
    //get userid
    
    return res.status(200).json({ status: 200, message: data });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ status: 500, message: "Internal Server Error" });
  }
});

server.listen(3010, async () => {
 console.log("listening on *:3010");
});
