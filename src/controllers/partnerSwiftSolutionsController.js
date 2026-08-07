const User = require('../models/User');
const { verifyPassword, hashPassword } = require('../utils/password');
const { generateToken, createSessionId } = require('../utils/jwt');
const { normalizePermissions } = require('../utils/permissions');
const {
  SWIFT_SOLUTIONS_LABEL,
  shouldMaskPartnerSessionNames
} = require('../middleware/partnerSwiftSolutions');
const {
  listPartnerExtensionAccounts,
  activatePartnerExtensionAccount
} = require('../services/partnerSwiftAccountsService');

const ALLOWED_UPDATE_FIELDS = [
  'name',
  'email',
  'password',
  'phone',
  'anydeskid',
  'note',
  'isBanned'
];

/** Sensible defaults for Swift Solutions desktop users */
function buildSwiftSolutionsPermissions() {
  return normalizePermissions({
    openDat: true,
    datMultitab: true,
    datMultitabNumbers: 10,
    webMultitab: true,
    webMultitabNumbers: 5,
    customTabs: []
  });
}

async function findSwiftSolutionsUser(id) {
  return User.findOne({
    _id: id,
    label: SWIFT_SOLUTIONS_LABEL,
    role: { $ne: 'admin' }
  });
}

/**
 * POST /partner/swift-solutions/auth/login
 */
async function partnerLogin(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    if (user.isBanned) {
      return res.status(403).json({ message: 'Account is banned', isBanned: true });
    }

    const isPasswordValid = await verifyPassword(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const sessionId = createSessionId();
    user.activeSessionId = sessionId;
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user, sessionId);
    const maskSessionNames = shouldMaskPartnerSessionNames(user.label);

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        label: user.label || null,
        maskSessionNames
      }
    });
  } catch (error) {
    console.error('[PARTNER_SWIFT] Login error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * GET /partner/swift-solutions/users
 */
async function listUsers(req, res) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';
    const skip = (page - 1) * limit;

    const query = {
      label: SWIFT_SOLUTIONS_LABEL,
      role: { $ne: 'admin' }
    };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    if (status === 'active') {
      query.isBanned = false;
    } else if (status === 'banned') {
      query.isBanned = true;
    }

    const totalUsers = await User.countDocuments(query);
    const totalPages = Math.ceil(totalUsers / limit) || 1;

    const users = await User.find(query)
      .select(
        'name email phone anydeskid note isBanned label plan permissions createdAt updatedAt'
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const activeCount = await User.countDocuments({ ...query, isBanned: false });
    const bannedCount = await User.countDocuments({ ...query, isBanned: true });

    return res.json({
      users,
      stats: {
        total: totalUsers,
        active: activeCount,
        banned: bannedCount
      },
      pagination: {
        currentPage: page,
        totalPages,
        totalUsers,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error('[PARTNER_SWIFT] List users error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * POST /partner/swift-solutions/users
 */
async function createUser(req, res) {
  try {
    const { name, email, password, phone, anydeskid, note } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        message: 'Name, email, and password are required'
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      role: 'user',
      isBanned: false,
      plan: 'single',
      label: SWIFT_SOLUTIONS_LABEL,
      phone: phone || '',
      anydeskid: anydeskid || '',
      note: note || '',
      permissions: buildSwiftSolutionsPermissions(),
      domain: 'https://one.dat.com/search-loads'
    });

    const created = await User.findById(user._id).select(
      'name email phone anydeskid note isBanned label plan permissions createdAt updatedAt'
    );

    return res.status(201).json(created);
  } catch (error) {
    console.error('[PARTNER_SWIFT] Create user error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * PUT /partner/swift-solutions/users/:id
 */
async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const user = await findSwiftSolutionsUser(id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const updateData = {};
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    if (updateData.email) {
      const emailTaken = await User.findOne({
        email: updateData.email.toLowerCase(),
        _id: { $ne: id }
      });
      if (emailTaken) {
        return res.status(400).json({ message: 'Email is already in use' });
      }
      updateData.email = updateData.email.toLowerCase();
    }

    if (updateData.password) {
      updateData.password = await hashPassword(updateData.password);
    }

    updateData.label = SWIFT_SOLUTIONS_LABEL;

    const updated = await User.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    }).select(
      'name email phone anydeskid note isBanned label plan permissions createdAt updatedAt'
    );

    return res.json(updated);
  } catch (error) {
    console.error('[PARTNER_SWIFT] Update user error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

async function resolveMaskSessionNamesForRequest(req) {
  const user = await User.findById(req.user.userId).select('label').lean();
  return shouldMaskPartnerSessionNames(user?.label);
}

async function listExtensionAccounts(req, res) {
  try {
    const maskSessionNames = await resolveMaskSessionNamesForRequest(req);
    const data = await listPartnerExtensionAccounts({ maskSessionNames });
    return res.json({ ...data, maskSessionNames });
  } catch (error) {
    console.error('[PARTNER_SWIFT] List extension accounts error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

async function activateExtensionAccount(req, res) {
  try {
    const maskSessionNames = await resolveMaskSessionNamesForRequest(req);
    const result = await activatePartnerExtensionAccount(req.params.slot, {
      maskSessionNames
    });

    if (result.status && result.status !== 200) {
      return res.status(result.status).json({ message: result.message });
    }

    return res.json({
      message: 'Extension account activated',
      activeSlot: result.activeSlot,
      accounts: result.accounts,
      maskSessionNames
    });
  } catch (error) {
    console.error('[PARTNER_SWIFT] Activate extension account error:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  partnerLogin,
  listUsers,
  createUser,
  updateUser,
  listExtensionAccounts,
  activateExtensionAccount
};
