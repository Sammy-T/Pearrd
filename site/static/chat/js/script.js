const configuration = {
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'}
    ]
};

const db = firebase.firestore();

let roomRef = null;
let connectionsRef = null;

let localUid = Math.random().toString(36).slice(-8);
let username = null;

const offerTimes = {};
const answerTimes = {};

const peerConnections = {};
const dataChannels = {};

let modalAction = null;

const roomIdInput = document.querySelector('#room-id-input');
const userAvatar = document.querySelector('#user-avatar');
const createRoomBtn = document.querySelector('#create-room');
const joinRoomBtn = document.querySelector('#join-room');
const hangUpBtn = document.querySelector('#hang-up');
const audioEnabledCheck = document.querySelector('#audio-enabled');
const videoEnabledCheck = document.querySelector('#video-enabled');
const videoOptions = document.querySelectorAll('.video-option');
const usernameModal = document.querySelector('#username-modal');

async function createRoom() {
    roomRef = db.collection('pearmo-rooms').doc();
    connectionsRef = roomRef.collection('connections');

    roomIdInput.value = roomRef.id;

    // Create room doc w/ local uid and created time
    const roomData = {
        participants: [localUid],
        created: firebase.firestore.FieldValue.serverTimestamp()
    };

    const res = await roomRef.set(roomData);
    console.log(`Created room. id: ${roomRef.id}`, res);

    addNegotiator();

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;
    videoOptions.forEach(optionEl => optionEl.disabled = true);
}

async function joinRoom() {
    // Check for a room id to join
    if(!roomIdInput.value) {
        console.warn('No room id to join.');
        return;
    }

    roomRef = db.collection('pearmo-rooms').doc(roomIdInput.value);
    connectionsRef = roomRef.collection('connections');

    const doc = await roomRef.get();

    if(!doc.exists) {
        console.warn('No room found.');
        return;
    }

    // Retrieve the room data
    const roomData = doc.data();
    console.log('Room', doc.id, roomData);

    // Check for uid overlap (This should rarely need to be called if ever)
    while(roomData.participants.includes(localUid)) {
        localUid = Math.random().toString(36).slice(-8);
        console.warn(`Uid conflict. New uid created: ${localUid}`);
    }

    // Update the room document
    const updateData = {
        participants: firebase.firestore.FieldValue.arrayUnion(localUid)
    };

    const res = await roomRef.update(updateData);
    console.log('Updated room.', res);

    // Create offers
    roomData.participants.forEach(participant => createOffer(participant));

    addNegotiator();

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;
    videoOptions.forEach(optionEl => optionEl.disabled = true);
}

function addNegotiator() {
    //// TODO: Store listener's unsub and call when unneeded
    connectionsRef.onSnapshot(snapshot => {
        snapshot.forEach(async doc => {
            const data = doc.data();
            console.log(doc.id, '=>', doc.data());

            if(data.from && data.from === localUid && data.answer && (!answerTimes[data.to] || answerTimes[data.to].getTime() != data.answerTime.toDate().getTime())) {
                console.log('Received new answer.', data.answer, data);

                const participant = data.to;
                const peerConnection = peerConnections[participant];

                // Update the participant's local answer time
                answerTimes[participant] = data.answerTime.toDate();

                const remoteDesc = new RTCSessionDescription(data.answer);
                await peerConnection.setRemoteDescription(remoteDesc);
            }else if(data.to && data.to === localUid && data.offer && (!offerTimes[data.from] || offerTimes[data.from].getTime() != data.offerTime.toDate().getTime())) {
                console.log('Received new offer.', data.offer, data);

                const participant = data.from;

                // Update the participant's local offer time
                offerTimes[participant] = data.offerTime.toDate();

                createAnswer(participant, doc);
            }
        });
    }, error => {
        console.error('Error listening to connections collection.\n', error);
    });
}

async function createOffer(participant) {
    // Create a connection
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections[participant] = peerConnection; // Map the connection to the participant

    registerPeerConnectionListeners(participant, peerConnection);

    // Create a data channel on the connection
    // (A channel or stream must be present for ICE candidate events to fire)
    const dataChannel = peerConnection.createDataChannel('messages');
    dataChannel[participant] = dataChannel; // Map the data channel to the participant

    registerDataChannelListeners(participant, dataChannel);

    const connectionDocRef = connectionsRef.doc(); // Create connection doc ref

    // Start collecting ICE candidates
    await collectIceCandidates(connectionDocRef, participant, peerConnection);

    // Create an offer and use it to set the local description
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log(participant, 'Created offer', offer);

    offerTimes[participant] = new Date(); // Map the offer time to the participant

    const connectionData = {
        from: localUid,
        to: participant,
        offerTime: firebase.firestore.Timestamp.fromDate(offerTimes[participant]),
        offer: {
            type: offer.type,
            sdp: offer.sdp
        },
        answerTime: null,
        answer: null
    };

    // Send the offer to the signaling channel
    const res = await connectionDocRef.set(connectionData);
    console.log(participant, `Created connection doc with offer. id: ${connectionDocRef.id}`, res);
}

async function createAnswer(participant, connectionDoc) {
    // Create a connection
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnection[participant] = peerConnection; // Map the connection to the participant

    registerPeerConnectionListeners(participant, peerConnection);

    // Listen for data channels
    peerConnection.addEventListener('datachannel', event => {
        const dataChannel = event.channel;
        dataChannels[participant] = dataChannel; // Map the data channel to the participant

        registerDataChannelListeners(participant, dataChannel);
    });

    // Start collecting ICE candidates
    await collectIceCandidates(connectionDoc.ref, participant, peerConnection);

    const connectionData = connectionDoc.data();

    // Use the offer to create the remote description
    const remoteDesc = new RTCSessionDescription(connectionData.offer);
    await peerConnection.setRemoteDescription(remoteDesc);

    // Create an answer and use it to set the local description
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    answerTimes[participant] = new Date();

    const answerData = {
        answerTime: firebase.firestore.Timestamp.fromDate(answerTimes[participant]),
        answer: {
            type: answer.type,
            sdp: answer.sdp
        }
    };

    // Send the answer to the signaling channel
    const res = await connectionDoc.ref.update(answerData);
    console.log(participant, `Updated connection doc with answer. id: ${connectionDoc.ref.id}`, res);
}

async function collectIceCandidates(connectionDocRef, participant, peerConnection) {
    const localCandidatesColl = connectionDocRef.collection(localUid);
    const remoteCandidatesColl = connectionDocRef.collection(participant);

    peerConnection.addEventListener('icecandidate', event => {
        if(event.candidate) {
            console.log(participant, 'Got candidate', event.candidate);

            // Send candidate to signaling channel
            localCandidatesColl.add(event.candidate.toJSON());
        }
    });

    //// TODO: Map listener's unsub to object and call when unneeded?
    // Listen to signaling channel for remote candidates
    remoteCandidatesColl.onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if(change.type === 'added') {
                const data = change.doc.data();
                console.log(participant, 'Got remote candidate', data);

                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data));
                } catch (error) {
                    console.error(participant, 'Error adding remote ICE candidate', error);
                }
            }
        });
    });
}

function registerPeerConnectionListeners(participant, peerConnection) {
    peerConnection.addEventListener('negotiationneeded', async event => {
        console.log(participant, 'Negotiation needed');

        //// TODO: Create new offers to connected participants
    });

    peerConnection.addEventListener('icegatheringstatechange', event => {
        console.log(participant, `ICE gathering state change: ${peerConnection.iceGatheringState}`);
    });

    peerConnection.addEventListener('connectionstatechange', event => {
        console.log(participant, `Connection state change: ${peerConnection.connectionState}`);
    });

    peerConnection.addEventListener('signalingstatechange', event => {
        console.log(participant, `Signaling state change: ${peerConnection.signalingState}`);
    });

    peerConnection.addEventListener('iceconnectionstatechange', event => {
        console.log(participant, `ICE connection state change: ${peerConnection.iceConnectionState}`);
    });
}

function registerDataChannelListeners(participant, dataChannel) {
    dataChannel.addEventListener('open', event => {
        console.log(participant, 'Data channel open');
    });

    dataChannel.addEventListener('close', event => {
        console.log(participant, 'Data channel close');
    });

    dataChannel.addEventListener('message', event => {
        console.log(participant, 'Message received: ', event.data);
    });
}

function hangUp() {
    //// TODO: Cleanup unsubs

    cleanUpDb();

    for(const participant in offerTimes) {
        delete offerTimes[participant];
    }

    for(const participant in answerTimes) {
        delete answerTimes[participant];
    }

    for(const participant in dataChannels) {
        const dataChannel = dataChannels[participant];
        dataChannel.close();

        delete dataChannels[participant]; // Remove the data channel from the global variable
    }

    for(const participant in peerConnections) {
        const peerConnection = peerConnections[participant];
        peerConnection.close();

        delete peerConnections[participant]; // Remove the peer connection from the global variable
    }

    // Update the UI
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
    hangUpBtn.disabled = true;
    videoOptions.forEach(optionEl => optionEl.disabled = !videoEnabledCheck.checked);
}

async function cleanUpDb() {
    // Retrieve connections authored by this uid
    const authoredConnections = await connectionsRef.where('from', '==', localUid).get();

    authoredConnections.forEach(async connection => {
        const remoteUid = connection.data().to; // Retrieve the participant's uid

        const localCandidates = await connection.ref.collection(localUid).get();
        const remoteCandidates = await connection.ref.collection(remoteUid).get();

        const batch = db.batch();

        // Delete each connection's candidate docs
        localCandidates.forEach(candidate => batch.delete(candidate.ref));
        remoteCandidates.forEach(candidate => batch.delete(candidate.ref));

        batch.delete(connection.ref); // Delete the connection doc

        await batch.commit();
    });

    const roomDoc = await roomRef.get();

    if(roomDoc.exists) {
        const participants = roomDoc.data().participants;

        // If there are more than 2 participants left, remove localUid from room doc
        // Otherwise, delete the room doc
        if(participants.length > 2) {
            const updateData = {
                participants: firebase.firestore.FieldValue.arrayRemove(localUid)
            };

            const res = await roomRef.update(updateData);
            console.log('Deleted uid from room.', res);
        }else{
            const res = await roomRef.delete();
            console.log('Deleted room.', res);
        }
    }
}

function initModals() {
    // Show Share modal when share button is clicked
    document.querySelector('#share-id-btn').addEventListener('click', event => {
        document.querySelector('#share-modal').classList.add('active');
    });

    // Show Create Username modal when avatar is clicked
    userAvatar.addEventListener('click', event => {
        usernameModal.classList.add('active');
    });

    // Hide all modals when a close element is clicked 
    document.querySelectorAll('.close-modal').forEach(closeElement => {
        closeElement.addEventListener('click', event => {
            event.preventDefault();

            modalAction = null;

            document.querySelectorAll('.modal').forEach(modal => modal.classList.remove('active'));
        });
    });

    // Create Username modal
    const usernameField = document.querySelector('#username');
    const usernameHint = document.querySelector('#username-modal .form-input-hint');
    const createUsernameBtn = document.querySelector('#create-username');

    const usernameExp = /^\w+$/; // Match alpha-numeric characters including underscores

    const validationMsg = 'Username can only contain letters, numbers, or underscores.';

    // Set the username and close the modal
    function createUsername() {
        username = document.querySelector('#username').value;

        userAvatar.dataset.initial = username.substr(0,2).toUpperCase(); // Set the avatar initials

        usernameModal.classList.remove('active');
        
        // If the modal was triggered by another action,
        // continue with that action
        switch(modalAction){
            case 'createRoom':
                createRoom();
                break;
            case 'joinRoom':
                joinRoom();
                break;
        }

        modalAction = null;
    }

    // Validate the username input and display the validation state
    usernameField.addEventListener('input', function(event) {
        const isValidLength = this.value.length >= 5;
        const isValidUsername = usernameExp.test(this.value);

        // Remove previous validation state
        this.classList.remove('is-success', 'is-error');
        usernameHint.innerText = '';

        // Display input validation if the length requirement has been met
        if(isValidLength) {
            const validationClass = isValidUsername ? 'is-success' : 'is-error';
            this.classList.add(validationClass);

            usernameHint.innerText = !isValidUsername ? validationMsg : '';
        }

        createUsernameBtn.disabled = !(isValidLength && isValidUsername);
    });

    usernameField.addEventListener('keypress', function(event) {
        if(event.key === 'Enter' && !createUsernameBtn.disabled) createUsername();
    });

    createUsernameBtn.addEventListener('click', createUsername);
    hangUpBtn.addEventListener('click', hangUp);
}

function init() {
    // Populate the room id field if it's included in the url
    const searchParams = new URLSearchParams(location.search);
    if(searchParams.has('room')) roomIdInput.value = searchParams.get('room');

    initModals();

    // Show/Hide the stream area if either stream option is enabled
    function adjustUiToStreamOpts() {
        const streamArea = document.querySelector('#stream-area');
        const chatArea = document.querySelector('#chat-area');

        if(audioEnabledCheck.checked || videoEnabledCheck.checked) {
            streamArea.style.display = 'flex';
            chatArea.classList.remove('col-12');
            chatArea.classList.add('col-3');
        }else{
            streamArea.style.display = 'none';
            chatArea.classList.remove('col-3');
            chatArea.classList.add('col-12');
        }
    }

    audioEnabledCheck.addEventListener('change', function(event) {
        adjustUiToStreamOpts();
    });

    //// TODO: Handle video options when enabling video after already connected
    // Enable/Disable video options elements according to the video enabled element
    videoEnabledCheck.addEventListener('change', function(event) {
        adjustUiToStreamOpts();
        videoOptions.forEach(optionEl => optionEl.disabled = !this.checked);
    });

    createRoomBtn.addEventListener('click', event => {
        if(!username) {
            modalAction = 'createRoom';
            usernameModal.classList.add('active');
        }else{
            createRoom();
        }
    });

    joinRoomBtn.addEventListener('click', event => {
        if(!username) {
            modalAction = 'joinRoom';
            usernameModal.classList.add('active');
        }else{
            joinRoom();
        }
    });
}

init();