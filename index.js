const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require("dotenv").config();
// var nodemailer = require('nodemailer');
// var sgTransport = require('nodemailer-sendgrid-transport');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000

app.use(cors());
app.use(express.json())



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.asu4o.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyjwt(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: "UnAuthorized Access" });
    }
    const token = authHeader.split(" ")[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: "Forbidden access" })
        }
        req.decoded = decoded;
        next();
    });
}

async function run() {
    try {
        await client.connect();
        const serviceCollection = client.db("doctors_portal").collection("services");
        const bookingCollection = client.db("doctors_portal").collection("bookings");
        const usersCollection = client.db("doctors_portal").collection("users");
        const doctorsCollection = client.db("doctors_portal").collection("doctors");
        const paymentsCollection = client.db("doctors_portal").collection("payments");

        const verifyAdmin = async (req, res, next) => {
            const requester = req.decoded.email;
            const requestedAccount = await usersCollection.findOne({ email: requester });
            if (requestedAccount.role === "admin") {
                next();
            }
            else {
                res.status(403).send({ message: "Forbbidden" })
            }
        }
        app.post('/create-payment-intent', verifyjwt, async (req, res) => {
            const service = req.body;
            const price = service.price;
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            });
            res.send({ clientSecret: paymentIntent.client_secret })
        });

        app.get("/service", async (req, res) => {
            const query = {};
            const cursor = serviceCollection.find(query).project({ name: 1 });
            const services = await cursor.toArray();
            res.send(services);
        })

        app.get("/user", verifyjwt, async (req, res) => {
            const users = await usersCollection.find().toArray();
            res.send(users);
        })
        app.get("/admin/:email", async (req, res) => {
            const email = req.params.email;
            const user = await usersCollection.findOne({ email: email });
            const isAdmin = user.role === "admin";
            res.send({ admin: isAdmin });
        })
        app.put("/user/admin/:email", verifyjwt, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            // const requester = req.decoded.email;
            // const requestedAccount = await usersCollection.findOne({ email: requester })
            // if (requestedAccount.role === "admin") {
            const filter = { email: email };
            const updateDoc = {
                $set: { role: "admin" },
            };
            const result = await usersCollection.updateOne(filter, updateDoc);
            res.send(result);

        });

        app.put("/user/:email", async (req, res) => {
            const email = req.params.email;
            console.log(email);
            const user = req.body;
            const filter = { email: email };
            const options = { upsert: true };
            const updateDoc = {
                $set: user,
            };
            const result = await usersCollection.updateOne(filter, updateDoc, options);
            const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' })
            res.send({ result, token });
        });

        // Warning: This is not the proper way to query multiple collection.
        // After learning more about mongodb. use aggregate, lookup, pipeline, match, group
        app.get("/available", async (req, res) => {
            const date = req.query.date;
            console.log(date);
            //step 1 get all service
            const services = await serviceCollection.find().toArray();
            //step-2 get the booking of that day
            const query = { date: date }
            const bookings = await bookingCollection.find(query).toArray();
            // console.log(bookings);

            // step 3: for each service
            services.forEach(service => {
                // step 4: find bookings for that service. output: [{}, {}, {}, {}]
                const serviceBookings = bookings.filter(book => book.treatment === service.name);
                // step 5: select slots for the service Bookings: ['', '', '', '']
                const bookedSlots = serviceBookings.map(book => book.slot);
                // step 6: select those slots that are not in bookedSlots
                const available = service.slots.filter(slot => !bookedSlots.includes(slot));
                //step 7: set available to slots to make it easier 
                service.slots = available;
            });
            res.send(services);
        });


        /**
    * API Naming Convention
    * app.get('/booking') // get all bookings in this collection. or get more than one or by filter
    * app.get('/booking/:id') // get a specific booking 
    * app.post('/booking') // add a new booking
    * app.patch('/booking/:id) //
    * app.put('/booking/:id') // upsert ==> update (if exists) or insert (if doesn't exist)
    * app.delete('/booking/:id) //
    */
        app.get("/booking", verifyjwt, async (req, res) => {
            const patient = req.query.patient;
            const decodedEmail = req.decoded.email;
            // console.log('decoded email', patient);
            if (patient === decodedEmail) {
                const query = { patient: patient }
                const bookings = await bookingCollection.find(query).toArray();
                return res.send(bookings);
            }
            else {
                return res.status(403).send({ message: "Forbidden access" })
            }

        })

        app.get("/booking/:id", verifyjwt, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) }
            const booking = await bookingCollection.findOne(query);
            res.send(booking);
        })
        app.post("/booking", async (req, res) => {
            const booking = req.body;
            const query = { treatment: booking.treatment, date: booking.date, patient: booking.patient }
            const exists = await bookingCollection.findOne(query);
            if (exists) {
                return res.send({ success: false, booking: exists })
            }
            const result = await bookingCollection.insertOne(booking);
            return res.send({ success: true, result });
        });
        app.patch("/booking/:id", async (req, res) => {
            const id = req.params.id;
            const payment = req.body;
            const filter = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const result = await paymentsCollection.insertOne(payment);
            const updatedBooking = await bookingCollection.updateOne(filter, updatedDoc);
            res.send(updatedBooking);
        })


        app.get("/doctor", verifyjwt, verifyAdmin, async (req, res) => {
            const doctors = await doctorsCollection.find().toArray();
            res.send(doctors);

        })
        app.post("/doctor", verifyjwt, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })
        app.delete("/doctor/:email", verifyjwt, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email }
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        })

    }
    finally {

    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})