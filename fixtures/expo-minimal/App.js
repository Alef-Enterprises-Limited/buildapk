import React from 'react';
import { SafeAreaView, Text, StyleSheet } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>BuildAPK works</Text>
      <Text>This release runs without Metro.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f4f7fa' },
  title: { fontSize: 28, fontWeight: 'bold', marginBottom: 16 },
});
