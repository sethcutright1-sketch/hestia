plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.householdapp.wear"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.householdapp.wear"
        // Wear OS 3+ (Galaxy Watch4 and later) only -- no Tizen/older-watch support.
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.wear.compose:compose-material:1.3.1")
    implementation("androidx.wear.compose:compose-foundation:1.3.1")
    implementation("androidx.wear:wear-tooling-preview:1.0.0")
    // RemoteInputIntentHelper -- launches the watch's voice/keyboard text-entry
    // activity for the pairing screen (server URL + device token).
    implementation("androidx.wear:wear-input:1.1.0")

    // Networking: talks to household-app's Express API over the Tailscale URL.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Encrypted storage for the device token (see ApiClient.kt) -- must not
    // sit in plain SharedPreferences since it's a long-lived credential.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // JSON is in the Android SDK (org.json), no separate dependency needed.
}
