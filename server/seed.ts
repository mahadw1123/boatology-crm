import * as db from "./db";
import { hashPassword } from "./_core/auth";
import { runMigrations } from "./migrate";
import { ENV } from "./_core/env";

if (ENV.isProd) {
  console.error("[FATAL] Demo seeding is disabled in production. Create the first administrator through the secure setup page instead.");
  process.exit(1);
}

runMigrations();


async function main() {
  console.log("[Seed] Starting...");

  const existingAdmin = await db.getUserByEmail("admin@boatology.com");
  if (!existingAdmin) {
    await db.createUser({
      openId: "local:admin@boatology.com",
      name: "Roger Admin",
      email: "admin@boatology.com",
      passwordHash: await hashPassword("boatology123"),
      role: "admin",
      loginMethod: "password",
    });
    console.log("[Seed] Created admin@boatology.com / boatology123");
  }

  const existingOffice = await db.getUserByEmail("office@boatology.com");
  if (!existingOffice) {
    await db.createUser({
      openId: "local:office@boatology.com",
      name: "Office Staff",
      email: "office@boatology.com",
      passwordHash: await hashPassword("boatology123"),
      role: "office_staff",
      loginMethod: "password",
    });
    console.log("[Seed] Created office@boatology.com / boatology123");
  }

  const customers = await db.getCustomers();
  let customerId: number;
  if (customers.length === 0) {
    const customer = await db.createCustomer({
      name: "James Whitfield",
      email: "james.whitfield@example.com",
      phone: "0400 123 456",
      address: "12 Marina Drive, Gold Coast QLD",
      insuranceClaimNumber: "CLM-2026-0091",
      notes: "Long-time customer, prefers morning appointments.",
    });
    customerId = customer.id;
    console.log("[Seed] Created sample customer");
  } else {
    customerId = customers[0].id;
  }

  const vessels = await db.getVesselsByCustomer(customerId);
  let vesselId: number;
  if (vessels.length === 0) {
    const vessel = await db.createVessel({
      customerId,
      name: "Sea Spirit",
      make: "Riviera",
      model: "4800 Sport Yacht",
      registration: "QLD-8821",
      location: "Marina Berth 14",
      insuranceDetails: "Allianz Marine, Policy #AM-55210",
    });
    vesselId = vessel.id;
    console.log("[Seed] Created sample vessel");
  } else {
    vesselId = vessels[0].id;
  }

  const quotes = await db.getQuotes();
  if (quotes.length === 0) {
    await db.createQuote({
      customerId,
      vesselId,
      quoteNumber: "Q-2026-001",
      status: "pending_approval",
      lineItems: [
        { description: "Engine service (twin diesel)", quantity: 1, unitPrice: 1850 },
        { description: "Hull antifoul application", quantity: 1, unitPrice: 2200 },
      ],
      laborCost: 1400,
      partsCost: 2650,
      totalAmount: 4050,
      notes: "Includes haul-out and pressure wash.",
      expiryDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    });
    console.log("[Seed] Created sample quote");
  }

  const jobs = await db.getJobs();
  if (jobs.length === 0) {
    await db.createJob({
      customerId,
      vesselId,
      jobNumber: "J-2026-014",
      status: "in_progress",
      description: "Engine service and hull antifoul — Sea Spirit",
      estimatedLaborHours: 6,
      priority: "high",
      dueDate: new Date().toISOString().slice(0, 10),
    });
    console.log("[Seed] Created sample job due today");
  }

  const employees = await db.getEmployees();
  if (employees.length === 0) {
    await db.createEmployee({ name: "Mick Tanner", role: "technician", email: "mick@boatology.com" });
    await db.createEmployee({ name: "Dana Reeves", role: "technician", email: "dana@boatology.com" });
    await db.createEmployee({ name: "Hami Al-Farsi", role: "management", email: "hami@boatology.com" });
    console.log("[Seed] Created sample employees");
  }

  // Demo login for a technician — linked to Mick Tanner's employee record so
  // assignments/time entries line up correctly.
  const existingTech = await db.getUserByEmail("technician@boatology.com");
  if (!existingTech) {
    const techEmployee = (await db.getEmployees()).find((e) => e.email === "mick@boatology.com");
    await db.createUser({
      openId: "local:technician@boatology.com",
      name: "Mick Tanner",
      email: "technician@boatology.com",
      passwordHash: await hashPassword("boatology123"),
      role: "technician",
      employeeId: techEmployee?.id,
      loginMethod: "password",
    });
    console.log("[Seed] Created technician@boatology.com / boatology123");
  }

  // Demo login for a customer — linked to the seeded customer record so the
  // Customer Portal shows their own quotes/jobs/photos.
  const existingCustomerLogin = await db.getUserByEmail("customer@boatology.com");
  if (!existingCustomerLogin) {
    await db.createUser({
      openId: "local:customer@boatology.com",
      name: "James Whitfield",
      email: "customer@boatology.com",
      passwordHash: await hashPassword("boatology123"),
      role: "customer",
      customerId,
      loginMethod: "password",
    });
    console.log("[Seed] Created customer@boatology.com / boatology123");
  }

  console.log("[Seed] Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
