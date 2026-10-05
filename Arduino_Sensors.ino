/*
  Arduino Uno Physical Sensor Sketch
  Matches the Frontend Workflow & Receiver Integration Guide:
    - Distance (HC-SR04): Trigger Pin 9, Echo Pin 10
    - Gas Sensor (MQ-2 / MQ-135): Analog Pin A0
    - Capacitive Touch (TTP223): Digital Pin 2
    - Pushbutton: Digital Pin 3 (Active LOW with internal PULLUP)

  Baud Rate: 115200 baud (8-N-1)
  Streams JSON matching: {"distance": 45, "gas": 320, "touch": "CLEAR", "button": "RELEASED"}
*/

// Hardware Pin Definitions
const int PIN_TRIG = 9;
const int PIN_ECHO = 10;
const int PIN_GAS = A0;
const int PIN_TOUCH = 2;
const int PIN_BUTTON = 3;

unsigned long lastSendTime = 0;
const unsigned long sendIntervalMs = 500; // 500ms broadcast interval

void setup() {
  Serial.begin(115200);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_TOUCH, INPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP); // Active LOW
  pinMode(PIN_GAS, INPUT);

  // Short delay for sensor stabilization
  delay(1000);
}

int measureDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long duration = pulseIn(PIN_ECHO, HIGH, 30000); // 30ms timeout (~500 cm)
  if (duration == 0) return 100; // Fallback timeout distance

  // Speed of sound: 343 m/s => 0.0343 cm/us / 2
  int dist = duration * 0.0343 / 2;
  return constrain(dist, 10, 110);
}

void loop() {
  // Read Serial commands from Transmitter downlink
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "PING") {
      Serial.println("{\"ack\":\"PONG\"}");
    }
  }

  unsigned long now = millis();
  if (now - lastSendTime >= sendIntervalMs) {
    lastSendTime = now;

    // 1. Measure Distance
    int distance = measureDistanceCm();

    // 2. Measure Gas (Map 0-1023 ADC to 200 - 700 ppm estimate)
    int rawGas = analogRead(PIN_GAS);
    int gasPpm = map(rawGas, 50, 800, 200, 700);
    gasPpm = constrain(gasPpm, 200, 700);

    // 3. Measure Touch (HIGH = TOUCHED)
    int touchRaw = digitalRead(PIN_TOUCH);
    const char* touchState = (touchRaw == HIGH) ? "TOUCHED" : "CLEAR";

    // 4. Measure Pushbutton (Active LOW with pullup: LOW = PRESSED)
    int btnRaw = digitalRead(PIN_BUTTON);
    const char* btnState = (btnRaw == LOW) ? "PRESSED" : "RELEASED";

    // Format serial JSON payload matching exact guide schema:
    Serial.print("{\"distance\":");
    Serial.print(distance);
    Serial.print(",\"gas\":");
    Serial.print(gasPpm);
    Serial.print(",\"touch\":\"");
    Serial.print(touchState);
    Serial.print("\",\"button\":\"");
    Serial.print(btnState);
    Serial.println("\"}");
  }
}
